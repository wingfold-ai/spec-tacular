//! Taking the terminal over, and always giving it back.
//!
//! Raw mode, the alternate screen and mouse capture go on together and come
//! off together, from three places: the [`Tui`] guard's `Drop` (every normal
//! exit, and any `?` that returns early), a panic hook (a bug must not leave
//! someone's shell unusable), and [`Tui::suspend`] (handing the terminal to
//! `$EDITOR`). Raw mode is also what turns ctrl+c into an ordinary key: with
//! `ISIG` off the kernel never raises `SIGINT` for it, so the app decides
//! what it means.

use std::io::{self, Stdout};
use std::sync::Once;

use crossterm::cursor::{Hide, Show};
use crossterm::event::{
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

/// The terminal, while the TUI owns it.
pub struct Tui {
    pub terminal: Terminal<CrosstermBackend<Stdout>>,
}

impl Tui {
    /// Takes the terminal over. Restores it again if any step fails.
    pub fn enter() -> io::Result<Self> {
        install_panic_hook();
        take_over().inspect_err(|_| restore())?;
        let terminal =
            Terminal::new(CrosstermBackend::new(io::stdout())).inspect_err(|_| restore())?;
        Ok(Self { terminal })
    }

    /// Gives the terminal back for a while — to an editor.
    pub fn suspend(&mut self) {
        restore();
    }

    /// Takes it over again, and forgets what was on screen: the editor drew
    /// over all of it.
    ///
    /// A fresh `Terminal` over a cleared screen rather than
    /// `Terminal::clear`, which asks the terminal where its cursor is and
    /// waits up to two seconds for an answer some terminals never send.
    pub fn resume(&mut self) -> io::Result<()> {
        take_over()?;
        execute!(io::stdout(), Clear(ClearType::All))?;
        self.terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
        Ok(())
    }
}

impl Drop for Tui {
    fn drop(&mut self) {
        restore();
    }
}

fn take_over() -> io::Result<()> {
    enable_raw_mode()?;
    // Bracketed paste: a pasted text arrives as one event rather than as
    // keystrokes, so its line breaks are text and not a string of enters.
    execute!(
        io::stdout(),
        EnterAlternateScreen,
        EnableMouseCapture,
        EnableBracketedPaste,
        Hide
    )
}

/// Undoes [`take_over`]. Every step is attempted even if one fails, and
/// failures are ignored: this runs on the way out, often from a panic, where
/// there is nobody left to report to and half a restore beats none.
pub fn restore() {
    let _ = execute!(
        io::stdout(),
        DisableBracketedPaste,
        DisableMouseCapture,
        LeaveAlternateScreen,
        Show
    );
    let _ = disable_raw_mode();
}

/// Restores the terminal before the panic message prints, so the message is
/// readable and the shell is usable afterwards.
fn install_panic_hook() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            restore();
            previous(info);
        }));
    });
}
