//! The TUI shell.
//!
//! Two regions never leave the screen — the pipeline bar and the status line —
//! because "always visible" is the requirement this exists to meet
//! (docs/tui-design.md, "The constant frame").
//!
//! Kept thin: all derivation lives in `core/`, which is why the review loop's
//! behaviour is tested without a terminal and the screens only draw. Ratatui
//! over crossterm, driven by a tokio event loop:
//!
//! - [`app`] holds the state and turns events into state changes and
//!   [`app::Effect`]s — work to spawn, or the editor to run;
//! - [`view`] (with [`home`], [`review`], [`document`] and [`jobs`]) draws a
//!   frame from `&App`;
//! - [`ports`] is everything the app needs from the world, as a trait, with
//!   the real implementation over `commands`/`adapter` and a fake for tests;
//! - [`terminal`] takes the terminal over and always gives it back;
//! - this module is the loop that ties them together.
//!
//! ctrl+c is a key the application handles, never a signal that kills it:
//! it goes back or cancels one level, and `q` is what quits.

pub mod app;
pub mod document;
pub mod editor;
#[cfg(test)]
mod fake;
pub mod guide;
pub mod home;
pub mod input;
pub mod jobs;
pub mod logo;
pub mod ports;
pub mod review;
pub mod terminal;
#[cfg(test)]
mod tests;
pub mod theme;
pub mod view;
pub mod widgets;

use std::collections::VecDeque;
use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::task::Poll;
use std::time::Duration;

use chrono::Utc;
use crossterm::event::{Event, EventStream};
use futures_core::Stream;
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::mpsc;
use tokio::time::{interval, MissedTickBehavior};

use app::{App, Effect, Msg};
use ports::{Ports, ProjectPorts};
use terminal::Tui;

/// One frame of animation: the logo's typing and drift, the spinners.
const TICK: Duration = Duration::from_millis(70);
/// How often a running job is checked for having finished.
const POLL: Duration = Duration::from_secs(2);

/// Runs the TUI on `root` until the developer quits. The process exit code.
pub fn run(root: PathBuf, openspec_bin: Option<PathBuf>, driver: &str) -> u8 {
    let ports: Arc<dyn Ports> = Arc::new(ProjectPorts::new(root, openspec_bin, driver));
    // Current-thread: the work it spawns is waiting on subprocesses, and a
    // thread pool would cost startup — the thing the port exists to fix.
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("Could not start the async runtime: {error}");
            return 1;
        }
    };
    match runtime.block_on(event_loop(ports)) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("spectacular: {error}");
            1
        }
    }
}

/// The next terminal event, or never while the stream is set aside for the
/// editor.
async fn next_event(events: &mut Option<EventStream>) -> Option<io::Result<Event>> {
    std::future::poll_fn(|cx| match events.as_mut() {
        Some(stream) => Pin::new(stream).poll_next(cx),
        None => Poll::Pending,
    })
    .await
}

async fn event_loop(ports: Arc<dyn Ports>) -> io::Result<()> {
    let mut tui = Tui::enter()?;
    let (tx, mut rx) = mpsc::unbounded_channel::<Msg>();
    let (mut app, first) = App::new(ports.as_ref());
    let mut events = Some(EventStream::new());
    let mut tick = interval(TICK);
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut poll = interval(POLL);
    poll.set_missed_tick_behavior(MissedTickBehavior::Skip);
    // Closing the terminal window, or being asked to stop, quits like `q`:
    // the guard restores the terminal on the way out, and jobs, being
    // detached, carry on.
    let mut term = signal(SignalKind::terminate())?;
    let mut hup = signal(SignalKind::hangup())?;

    let mut pending: VecDeque<Effect> = first.into();
    let mut dirty = true;
    loop {
        while let Some(effect) = pending.pop_front() {
            match effect {
                Effect::Spawn(work) => {
                    let tx = tx.clone();
                    tokio::spawn(async move {
                        // The receiver only goes when the loop has ended.
                        let _ = tx.send(work.await);
                    });
                }
                Effect::Editor { file, line, then } => {
                    // The event stream reads stdin from a thread of its own;
                    // left running it would steal the editor's keystrokes.
                    drop(events.take());
                    tui.suspend();
                    let result = editor::open_in_editor(&file, line);
                    tui.resume()?;
                    events = Some(EventStream::new());
                    dirty = true;
                    pending.extend(app.on_msg(ports.as_ref(), Msg::EditorClosed { result, then }));
                }
            }
        }
        if app.quit {
            return Ok(());
        }
        if dirty {
            let mut hits = Vec::new();
            tui.terminal
                .draw(|frame| hits = view::render(&app, frame))?;
            app.hits = hits;
        }
        // Every branch below decides afresh whether the next pass redraws.

        tokio::select! {
            event = next_event(&mut events) => match event {
                Some(Ok(event)) => {
                    dirty = true;
                    pending.extend(app.on_event(ports.as_ref(), &event));
                }
                Some(Err(error)) => return Err(error),
                None => return Ok(()),
            },
            _ = tick.tick() => {
                app.on_tick(Utc::now());
                dirty = app.animating();
            },
            _ = poll.tick() => {
                // Redrawn either way: a running job's tail and elapsed time
                // moved even if it has not finished.
                dirty = true;
                pending.extend(app.on_poll(ports.as_ref()));
            },
            Some(msg) = rx.recv() => {
                dirty = true;
                pending.extend(app.on_msg(ports.as_ref(), msg));
            },
            _ = term.recv() => return Ok(()),
            _ = hup.recv() => return Ok(()),
        }
    }
}
