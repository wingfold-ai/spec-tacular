//! One ACP agent process and the session spec-tacular holds with it.
//!
//! [`AcpSession::start`] spawns the agent's command in a process group of
//! its own, speaks JSON-RPC over its stdio through the `agent-client-protocol`
//! SDK, initializes, and opens a session in the project directory. From then
//! on the session is driven by commands — a prompt, a cancel, an answer to a
//! permission request — and reports through a channel of [`AcpEvent`]s.
//!
//! The connection runs on a task of its own, so nothing here waits on the
//! agent: a prompt is sent and returns at once, and its end arrives as
//! [`AcpEvent::TurnEnded`]. A permission request is parked with its
//! responder and surfaced as [`AcpEvent::Permission`]; it holds up only the
//! agent that asked, until [`AcpSession::answer`] (or a cancel) replies.
//!
//! The process dies with the session. Dropping the last handle, closing it,
//! or the runtime shutting down all signal the agent's whole group — an
//! adapter like `npx … claude-agent-acp` is a tree of processes, and killing
//! only the direct child leaves the rest running.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionNotification, TextContent,
};
use agent_client_protocol::schema::{v1::Implementation, ProtocolVersion};
use agent_client_protocol::{Agent, Client, ConnectionTo, Lines, Responder};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use super::events::{map_update, permission_ask, AcpEvent, Stop};
use crate::agent::driver::AgentCommand;
use crate::core::jobs::signal_group;

/// How long an agent may take to start and open a session. `npx` fetching
/// an adapter's dependencies is the slow case.
pub const START_TIMEOUT: Duration = Duration::from_secs(90);

/// How many of the agent's last stderr lines are kept, to say why it died.
const STDERR_TAIL: usize = 20;

/// What the session's task is asked to do.
enum Command {
    Prompt(String),
    Cancel,
}

/// Permission requests waiting for an answer, by this client's number.
type Pending = Arc<Mutex<BTreeMap<u64, Responder<RequestPermissionResponse>>>>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Kills the agent's process group when dropped — the task ending, being
/// aborted, or the runtime going away.
struct GroupGuard(Option<i32>);

impl Drop for GroupGuard {
    fn drop(&mut self) {
        if let Some(pid) = self.0.take() {
            signal_group(pid, libc::SIGKILL);
        }
    }
}

struct Inner {
    commands: mpsc::UnboundedSender<Command>,
    session_id: String,
    agent: String,
    pid: Option<u32>,
    pending: Pending,
    alive: Arc<AtomicBool>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        // The last handle is gone: nobody can prompt it or read it again.
        if self.alive.swap(false, Ordering::SeqCst) {
            if let Some(pid) = self.pid.and_then(|p| i32::try_from(p).ok()) {
                signal_group(pid, libc::SIGKILL);
            }
        }
    }
}

/// A live session with an ACP agent. Cheap to clone; the agent is killed
/// when the last clone goes (or on [`AcpSession::close`]).
#[derive(Clone)]
pub struct AcpSession {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for AcpSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AcpSession")
            .field("session_id", &self.inner.session_id)
            .field("agent", &self.inner.agent)
            .field("pid", &self.inner.pid)
            .finish()
    }
}

/// The agent's stdout as the SDK's line transport wants it.
fn line_stream(
    stdout: tokio::process::ChildStdout,
) -> impl futures::Stream<Item = std::io::Result<String>> + Send + 'static {
    futures::stream::unfold(BufReader::new(stdout).lines(), |mut lines| async move {
        match lines.next_line().await {
            Ok(Some(line)) => Some((Ok(line), lines)),
            Ok(None) => None,
            Err(error) => Some((Err(error), lines)),
        }
    })
}

/// The agent's stdin as the SDK's line transport wants it.
fn line_sink(
    stdin: tokio::process::ChildStdin,
) -> impl futures::Sink<String, Error = std::io::Error> + Send + 'static {
    futures::sink::unfold(stdin, |mut stdin, line: String| async move {
        stdin.write_all(line.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok::<_, std::io::Error>(stdin)
    })
}

impl AcpSession {
    /// Spawns `command` in `cwd`, initializes it and opens a session there.
    /// The session, and the channel its events arrive on.
    ///
    /// Every failure is one sentence: a missing binary is named, and an
    /// agent that died says the last thing it wrote on stderr.
    pub async fn start(
        command: &AgentCommand,
        cwd: &Path,
    ) -> Result<(AcpSession, mpsc::UnboundedReceiver<AcpEvent>), String> {
        let mut child = tokio::process::Command::new(&command.command)
            .args(&command.args)
            .current_dir(cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            // A group, not a session: this agent is meant to die with us.
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    format!("`{}` is not installed", command.command)
                } else {
                    format!("could not run `{}`: {error}", command.command)
                }
            })?;
        let pid = child.id();
        let guard = GroupGuard(pid.and_then(|p| i32::try_from(p).ok()));
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err(format!("could not talk to `{}`", command.command));
        };

        let tail: Arc<Mutex<Vec<String>>> = Arc::default();
        {
            let tail = Arc::clone(&tail);
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut tail = lock(&tail);
                    if tail.len() == STDERR_TAIL {
                        tail.remove(0);
                    }
                    tail.push(line);
                }
            });
        }

        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let (commands_tx, commands_rx) = mpsc::unbounded_channel();
        let (ready_tx, ready_rx) = oneshot::channel();
        let pending: Pending = Arc::default();
        let alive = Arc::new(AtomicBool::new(true));

        tokio::spawn(connection(Connection {
            transport: (line_sink(stdin), line_stream(stdout)),
            cwd: cwd.to_path_buf(),
            events: events_tx,
            commands: commands_rx,
            ready: ready_tx,
            pending: Arc::clone(&pending),
            alive: Arc::clone(&alive),
            tail: Arc::clone(&tail),
            child,
            guard,
        }));

        let why = |fallback: String| {
            lock(&tail)
                .iter()
                .rev()
                .find(|l| !l.trim().is_empty())
                .map(|l| l.trim().to_owned())
                .unwrap_or(fallback)
        };
        let (session_id, agent) = match tokio::time::timeout(START_TIMEOUT, ready_rx).await {
            Err(_) => {
                return Err(format!(
                    "`{}` did not open a session within {}s",
                    command.command,
                    START_TIMEOUT.as_secs()
                ))
            }
            Ok(Err(_)) => return Err(why(format!("`{}` exited at start", command.command))),
            Ok(Ok(Err(error))) => return Err(why(error)),
            Ok(Ok(Ok(opened))) => opened,
        };
        let agent = agent.unwrap_or_else(|| command.command.clone());
        Ok((
            AcpSession {
                inner: Arc::new(Inner {
                    commands: commands_tx,
                    session_id,
                    agent,
                    pid,
                    pending,
                    alive,
                }),
            },
            events_rx,
        ))
    }

    /// The agent's id for the session.
    pub fn session_id(&self) -> &str {
        &self.inner.session_id
    }

    /// The agent's name, as it introduced itself.
    pub fn agent(&self) -> &str {
        &self.inner.agent
    }

    /// The agent process — the leader of its group.
    pub fn pid(&self) -> Option<u32> {
        self.inner.pid
    }

    /// Whether the agent is still there to prompt.
    pub fn is_alive(&self) -> bool {
        self.inner.alive.load(Ordering::SeqCst)
    }

    /// Starts a turn. Returns at once; the turn's end is an event.
    pub fn prompt(&self, text: impl Into<String>) -> Result<(), String> {
        if !self.is_alive() {
            return Err("the agent has stopped".to_owned());
        }
        self.inner
            .commands
            .send(Command::Prompt(text.into()))
            .map_err(|_| "the agent has stopped".to_owned())
    }

    /// Asks the agent to stop the turn (`session/cancel`), and answers any
    /// permission request still open as cancelled, as the protocol requires.
    pub fn cancel(&self) {
        let _ = self.inner.commands.send(Command::Cancel);
    }

    /// Answers permission request `id` with the option `choice` (the
    /// agent's option id), or as cancelled when `None`. Whether it was still
    /// waiting.
    pub fn answer(&self, id: u64, choice: Option<&str>) -> bool {
        let Some(responder) = lock(&self.inner.pending).remove(&id) else {
            return false;
        };
        let outcome = match choice {
            Some(option) => RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                option.to_owned(),
            )),
            None => RequestPermissionOutcome::Cancelled,
        };
        responder
            .respond(RequestPermissionResponse::new(outcome))
            .is_ok()
    }

    /// Ends the session and kills the agent's process group.
    pub fn close(&self) {
        if self.inner.alive.swap(false, Ordering::SeqCst) {
            if let Some(pid) = self.inner.pid.and_then(|p| i32::try_from(p).ok()) {
                signal_group(pid, libc::SIGKILL);
            }
        }
    }
}

/// Everything the connection task owns.
struct Connection<Out, In> {
    transport: (Out, In),
    cwd: PathBuf,
    events: mpsc::UnboundedSender<AcpEvent>,
    commands: mpsc::UnboundedReceiver<Command>,
    ready: oneshot::Sender<Result<(String, Option<String>), String>>,
    pending: Pending,
    alive: Arc<AtomicBool>,
    tail: Arc<Mutex<Vec<String>>>,
    child: tokio::process::Child,
    guard: GroupGuard,
}

/// Cancels every open permission request.
fn cancel_pending(pending: &Pending) {
    let open = std::mem::take(&mut *lock(pending));
    for (_, responder) in open {
        let _ = responder.respond(RequestPermissionResponse::new(
            RequestPermissionOutcome::Cancelled,
        ));
    }
}

/// The connection, from `initialize` until the agent goes away.
async fn connection<Out, In>(connection: Connection<Out, In>)
where
    Out: futures::Sink<String, Error = std::io::Error> + Send + 'static,
    In: futures::Stream<Item = std::io::Result<String>> + Send + 'static,
{
    let Connection {
        transport,
        cwd,
        events,
        mut commands,
        ready,
        pending,
        alive,
        tail,
        child,
        guard,
    } = connection;
    // The agent's exit, watched on a task of its own: the SDK notices a
    // closed pipe only when something is waiting on it, and the loop below
    // must end when the agent does, not when the next command comes.
    let (exit_tx, mut exited) = tokio::sync::watch::channel(None);
    tokio::spawn(async move {
        let mut child = child;
        let status = child.wait().await.ok();
        let _ = exit_tx.send(Some(status));
    });
    let next_permission = Arc::new(AtomicU64::new(0));
    let updates = events.clone();
    let asks = events.clone();
    let parked = Arc::clone(&pending);
    let update_cwd = cwd.clone();
    let ask_cwd = cwd.clone();
    let mut ready = Some(ready);
    let ready_slot = &mut ready;

    let result = Client
        .builder()
        .name("spec-tacular")
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                for event in map_update(&notification.update, &update_cwd) {
                    let _ = updates.send(event);
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest,
                        responder: Responder<RequestPermissionResponse>,
                        _cx| {
                let id = next_permission.fetch_add(1, Ordering::SeqCst) + 1;
                let ask = permission_ask(id, &request, &ask_cwd);
                lock(&parked).insert(id, responder);
                let _ = asks.send(AcpEvent::Permission(ask));
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(
            Lines::new(transport.0, transport.1),
            async |cx: ConnectionTo<Agent>| {
                let init = cx
                    .send_request(InitializeRequest::new(ProtocolVersion::V1).client_info(
                        Implementation::new("spec-tacular", env!("CARGO_PKG_VERSION")),
                    ))
                    .block_task()
                    .await;
                let init = match init {
                    Ok(init) => init,
                    Err(error) => {
                        if let Some(ready) = ready_slot.take() {
                            let _ =
                                ready.send(Err(format!("the agent did not initialize: {error}")));
                        }
                        return Ok(());
                    }
                };
                let opened = cx
                    .send_request(NewSessionRequest::new(cwd.clone()))
                    .block_task()
                    .await;
                let session_id = match opened {
                    Ok(opened) => opened.session_id.0.to_string(),
                    Err(error) => {
                        if let Some(ready) = ready_slot.take() {
                            let _ =
                                ready.send(Err(format!("the agent opened no session: {error}")));
                        }
                        return Ok(());
                    }
                };
                let agent = init.agent_info.map(|info| info.title.unwrap_or(info.name));
                if let Some(ready) = ready_slot.take() {
                    if ready.send(Ok((session_id.clone(), agent))).is_err() {
                        // Nobody is waiting any more: the start timed out.
                        return Ok(());
                    }
                }

                loop {
                    let command = tokio::select! {
                        command = commands.recv() => command,
                        _ = exited.changed() => None,
                    };
                    let Some(command) = command else { break };
                    match command {
                        Command::Prompt(text) => {
                            let request = PromptRequest::new(
                                session_id.clone(),
                                vec![ContentBlock::Text(TextContent::new(text))],
                            );
                            let sent = cx.send_request(request);
                            let events = events.clone();
                            // Off the loop: a prompt runs for minutes, and
                            // cancels and answers must get through meanwhile.
                            cx.spawn(async move {
                                let stop = match sent.block_task().await {
                                    Ok(response) => Stop::from_wire(response.stop_reason),
                                    Err(error) => Stop::Failed(error.to_string()),
                                };
                                let _ = events.send(AcpEvent::TurnEnded(stop));
                                Ok(())
                            })?;
                        }
                        Command::Cancel => {
                            cancel_pending(&pending);
                            cx.send_notification(CancelNotification::new(session_id.clone()))?;
                        }
                    }
                }
                Ok(())
            },
        )
        .await;

    // The agent is gone, or every handle to it is. Either way, it goes.
    let was_alive = alive.swap(false, Ordering::SeqCst);
    cancel_pending(&pending);
    drop(guard);
    let status = match exited.wait_for(Option::is_some).await {
        Ok(status) => (*status).flatten(),
        Err(_) => None,
    };
    let why = match (&result, status) {
        _ if !was_alive => None,
        (Err(error), _) => Some(error.to_string()),
        (Ok(()), Some(status)) if !status.success() => Some(
            lock(&tail)
                .iter()
                .rev()
                .find(|l| !l.trim().is_empty())
                .map(|l| l.trim().to_owned())
                .unwrap_or_else(|| format!("it exited ({status})")),
        ),
        (Ok(()), _) => Some("it exited".to_owned()),
    };
    let _ = events.send(AcpEvent::Closed(why));
}
