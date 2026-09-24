//! A scripted ACP agent, for tests: JSON-RPC over stdio, the protocol's v1
//! wire format written out by hand — deliberately not through the SDK the
//! client uses, so the client is checked against the protocol rather than
//! against itself.
//!
//! It answers `initialize` and `session/new`, and plays a script on every
//! `session/prompt`. The script is chosen with `--script <name>` or, failing
//! that, the `FAKE_ACP_SCRIPT` environment variable:
//!
//! - `draft` (the default): streams a reply and a plan, announces a tool call
//!   carrying the file's diff, asks permission to write it, writes it only if
//!   allowed (and stops saying so if not), and ends the turn with `end_turn`.
//!   "Allow always" is remembered: the session's later writes do not ask.
//! - `slow`: streams a line, then works "forever" — until `session/cancel`
//!   arrives, when the turn ends `cancelled` a quarter of a second later, or
//!   30 s pass.
//! - `crash`: streams a line and exits mid-turn.
//!
//! The file to write is named in the first prompt of a session, on a line
//! `write: <path relative to the session's cwd>`; later prompts in the same
//! session revise that file, quoting their feedback into it. A prompt for a
//! session this process did not create is refused with an error — which is
//! how a test knows a redraft really reused its session.
//!
//! `--record <file>` appends one line per event worth asserting on:
//! `initialize`, `session <id>`, `prompt <n> <session id>`, `permission
//! <outcome>`, `cancel <session id>`, `wrote <path>`.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct Agent {
    script: String,
    record: Option<PathBuf>,
    inbox: Receiver<Value>,
    next_id: u64,
    session: Option<String>,
    cwd: PathBuf,
    target: Option<String>,
    prompts: usize,
    always: bool,
    cancelled: bool,
}

fn send(message: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{message}");
    let _ = out.flush();
}

impl Agent {
    fn note(&self, line: &str) {
        if let Some(path) = &self.record {
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
            {
                let _ = writeln!(file, "{line}");
            }
        }
    }

    fn update(&self, update: Value) {
        send(&json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": { "sessionId": self.session, "update": update },
        }));
    }

    fn say(&self, text: &str) {
        self.update(json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": text },
        }));
    }

    /// Takes a notification that arrived while waiting for something else.
    fn absorb(&mut self, message: &Value) {
        if message.get("method").and_then(Value::as_str) == Some("session/cancel") {
            self.cancelled = true;
            let session = message["params"]["sessionId"].as_str().unwrap_or_default();
            self.note(&format!("cancel {session}"));
        }
    }

    /// Waits for the response to request `id`, taking notifications meanwhile.
    fn response(&mut self, id: u64) -> Option<Value> {
        loop {
            let message = self.inbox.recv().ok()?;
            if message.get("id").and_then(Value::as_u64) == Some(id)
                && message.get("method").is_none()
            {
                return Some(message);
            }
            self.absorb(&message);
        }
    }

    /// Asks permission to write `path`; the chosen option's kind, or
    /// `cancelled`.
    fn ask(&mut self, tool: &str, path: &str) -> String {
        self.next_id += 1;
        let id = self.next_id;
        send(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/request_permission",
            "params": {
                "sessionId": self.session,
                "toolCall": {
                    "toolCallId": tool,
                    "title": format!("Write {path}"),
                    "kind": "edit",
                    "locations": [{ "path": self.cwd.join(path) }],
                },
                "options": [
                    { "optionId": "allow-once", "name": "Allow", "kind": "allow_once" },
                    { "optionId": "allow-always", "name": "Always allow", "kind": "allow_always" },
                    { "optionId": "reject", "name": "Reject", "kind": "reject_once" },
                ],
            },
        }));
        let Some(answer) = self.response(id) else {
            return "cancelled".to_owned();
        };
        let outcome = &answer["result"]["outcome"];
        let chosen = match outcome["outcome"].as_str() {
            Some("selected") => match outcome["optionId"].as_str() {
                Some("allow-once") => "allow_once",
                Some("allow-always") => "allow_always",
                _ => "reject_once",
            },
            _ => "cancelled",
        };
        self.note(&format!("permission {chosen}"));
        chosen.to_owned()
    }

    /// One turn of the `draft` script. The stop reason.
    fn draft(&mut self, prompt: &str) -> &'static str {
        if self.prompts == 1 {
            self.target = prompt
                .lines()
                .find_map(|l| l.strip_prefix("write: "))
                .map(|s| s.trim().to_owned());
        }
        let Some(target) = self.target.clone() else {
            self.say("No `write:` line in the prompt — nothing to do.");
            return "end_turn";
        };
        let path = self.cwd.join(&target);
        let old = std::fs::read_to_string(&path).ok();
        let feedback = prompt
            .lines()
            .find_map(|l| l.strip_prefix("> "))
            .unwrap_or("more detail")
            .to_owned();
        let content = match &old {
            None => {
                "# Proposal\n\n## Why\n\nDrafted over ACP.\n\n## What Changes\n\n- Add booking\n"
                    .to_owned()
            }
            Some(old) => format!("{old}\n## Revised\n\n{feedback}\n"),
        };

        self.say("Reading the ground rules.\n");
        // What real agents also send: a usage report with the session's
        // cost, and an extension notification the client must ignore.
        send(&json!({
            "jsonrpc": "2.0",
            "method": "_fake/status_update",
            "params": { "status": "busy" },
        }));
        self.update(json!({
            "sessionUpdate": "usage_update",
            "used": 1000 * self.prompts,
            "size": 200_000,
            "cost": { "amount": 0.01 * self.prompts as f64, "currency": "USD" },
        }));
        self.update(json!({
            "sessionUpdate": "plan",
            "entries": [
                { "content": "Read the context", "priority": "high", "status": "completed" },
                { "content": format!("Write {target}"), "priority": "high", "status": "in_progress" },
            ],
        }));
        self.say(if old.is_some() {
            "Revising the proposal with your feedback.\n"
        } else {
            "Drafting the proposal.\n"
        });
        let tool = format!("write-{}", self.prompts);
        self.update(json!({
            "sessionUpdate": "tool_call",
            "toolCallId": tool,
            "title": format!("Write {target}"),
            "kind": "edit",
            "status": "pending",
            "content": [{ "type": "diff", "path": path, "oldText": old, "newText": content }],
            "locations": [{ "path": path }],
        }));

        let allowed = if self.always {
            true
        } else {
            let chosen = self.ask(&tool, &target);
            if chosen == "allow_always" {
                self.always = true;
            }
            chosen.starts_with("allow")
        };
        if self.cancelled {
            return "cancelled";
        }
        if !allowed {
            self.update(json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": tool,
                "status": "failed",
            }));
            self.say("Understood — I will not write it.\n");
            return "end_turn";
        }
        self.update(json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": tool,
            "status": "in_progress",
        }));
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, &content);
        self.note(&format!("wrote {target}"));
        self.update(json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": tool,
            "status": "completed",
        }));
        self.say("Done.\n");
        "end_turn"
    }

    /// One turn of the `slow` script: works until cancelled.
    fn slow(&mut self) -> &'static str {
        self.say("Thinking about it for a long time.\n");
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            match self.inbox.recv_timeout(Duration::from_millis(50)) {
                Ok(message) => self.absorb(&message),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => std::process::exit(0),
            }
            if self.cancelled {
                // Stopping takes an agent a moment: long enough for a test
                // to see the TUI say it is waiting for it.
                std::thread::sleep(Duration::from_millis(250));
                return "cancelled";
            }
        }
        "end_turn"
    }

    fn prompt(&mut self, id: &Value, params: &Value) {
        let session = params["sessionId"].as_str().unwrap_or_default();
        if self.session.as_deref() != Some(session) {
            send(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32602, "message": format!("unknown session {session}") },
            }));
            return;
        }
        self.prompts += 1;
        self.cancelled = false;
        self.note(&format!("prompt {} {session}", self.prompts));
        let text: String = params["prompt"]
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|b| b["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        let stop = match self.script.as_str() {
            "slow" => self.slow(),
            "crash" => {
                self.say("About to fall over.\n");
                std::process::exit(3);
            }
            _ => self.draft(&text),
        };
        send(&json!({ "jsonrpc": "2.0", "id": id, "result": { "stopReason": stop } }));
    }

    fn run(&mut self) {
        while let Ok(message) = self.inbox.recv() {
            let Some(method) = message.get("method").and_then(Value::as_str) else {
                continue;
            };
            let id = message.get("id").cloned();
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            match (method, id) {
                ("initialize", Some(id)) => {
                    self.note("initialize");
                    send(&json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "protocolVersion": 1,
                            "agentCapabilities": { "loadSession": false },
                            "authMethods": [],
                            "agentInfo": { "name": "fake-acp-agent", "version": "0.0.0" },
                        },
                    }));
                }
                ("session/new", Some(id)) => {
                    let session = format!("fake-session-{}", std::process::id());
                    self.cwd = params["cwd"]
                        .as_str()
                        .map(PathBuf::from)
                        .unwrap_or_default();
                    self.note(&format!("session {session}"));
                    self.session = Some(session.clone());
                    send(
                        &json!({ "jsonrpc": "2.0", "id": id, "result": { "sessionId": session } }),
                    );
                }
                ("session/prompt", Some(id)) => self.prompt(&id, &params),
                ("session/cancel", None) => self.absorb(&message),
                (_, Some(id)) => send(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": format!("{method} is not supported") },
                })),
                (_, None) => {}
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let script = flag("--script")
        .or_else(|| std::env::var("FAKE_ACP_SCRIPT").ok())
        .unwrap_or_else(|| "draft".to_owned());
    let record = flag("--record").map(PathBuf::from);

    let (tx, inbox) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if tx.send(value).is_err() {
                    break;
                }
            }
        }
    });

    let mut agent = Agent {
        script,
        record,
        inbox,
        next_id: 0,
        session: None,
        cwd: Path::new(".").to_path_buf(),
        target: None,
        prompts: 0,
        always: false,
        cancelled: false,
    };
    agent.run();
}
