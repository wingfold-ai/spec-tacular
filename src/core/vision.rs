//! The vision interview: how a greenfield project gets from an idea to its
//! first change.
//!
//! OpenSpec's unit of work is a *change* against an existing baseline. On day
//! one there is no baseline, and "what do you want to change?" is the wrong
//! question — there is nothing to change yet (docs/problem-analysis.md §4). So
//! a greenfield project starts from its vision instead: described freely, then
//! sharpened by an interview that asks one question at a time until the
//! developer stops it or the model has enough, then split into an ordered
//! roadmap of slices. Each slice becomes a change when its turn comes.
//!
//! Like the Foundation advisor, the model proposes and the developer decides:
//! the slices are reviewed before anything is written to the roadmap.
//!
//! The whole of the TypeScript `core/vision.ts`: whether a project is new, the
//! saved interview (so it can be left and resumed), the prompts and their
//! schemas, the parsers over what the model sends back, writing the vision and
//! the roadmap, and the [`VisionInterviewer`] that walks through it. The model
//! is reached through the same injected [`Ask`] as the Foundation advisor, so
//! this module knows nothing about which agent answers — and is tested with a
//! scripted one.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::advisor::{parse_options, records, text_of, AdviceOption, Ask};
use super::foundation::guided_questions;
use super::guide::validate_change_name;
use super::naming::unique;
use super::roadmap::{promote_slice, save_roadmap, Roadmap, Slice, SliceChange, SliceStatus};

/// One question of the interview.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct InterviewQuestion {
    pub ask: String,
    /// One line: what the answer decides.
    pub why: String,
    pub options: Vec<AdviceOption>,
}

/// A question asked, and what the developer said.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct VisionTurn {
    pub ask: String,
    /// What the developer said, or `None` when they skipped the question.
    pub answer: Option<String>,
}

/// A slice the model proposes, before the developer has reviewed it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProposedSlice {
    /// Kebab-case; it becomes the change's name.
    pub id: String,
    pub title: String,
    /// What a user can do once it lands.
    pub summary: String,
    /// Why it comes at this point in the order.
    pub why: String,
    pub depends_on: Vec<String>,
}

/// The interview as it is saved, so it can be left and resumed.
///
/// The TypeScript's `VisionSession`, key for key: a session written by either
/// implementation resumes in the other. Every field has a default, and
/// unknown fields are ignored, so a partial or older file still reads.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct VisionSession {
    /// The developer's own description, as typed.
    pub vision: String,
    pub turns: Vec<VisionTurn>,
    /// The model's restatement of the vision, refined after every answer.
    pub understood: String,
    /// The question on screen, if any.
    pub pending: Option<InterviewQuestion>,
    /// The model has enough, or the developer ended the interview.
    pub finished: bool,
    pub slices: Vec<ProposedSlice>,
    /// The model's one-paragraph vision, from splitting it into slices.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refined: Option<String>,
    /// Not a new project after all — start from a single change instead.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub skipped: bool,
}

/// Past this many answers the interview ends, whatever the model thinks.
pub const MAX_TURNS: usize = 12;

// ---------------------------------------------------------------------------
// Greenfield

/// Whether the project starts from nothing: no accepted specs in the baseline
/// and nothing archived.
///
/// Existing code without specs also reads as greenfield, which is why the
/// vision screen offers a way out.
pub fn is_greenfield(project_root: impl AsRef<Path>) -> bool {
    let project_root = project_root.as_ref();
    let archive = project_root
        .join("openspec")
        .join("changes")
        .join("archive");
    let archived = fs::read_dir(&archive).is_ok_and(|entries| {
        entries
            .flatten()
            .any(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
    });
    !has_markdown(&project_root.join("openspec").join("specs")) && !archived
}

fn has_markdown(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if has_markdown(&path) {
                return true;
            }
        } else if path.extension().is_some_and(|ext| ext == "md") {
            return true;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Persistence: an interview can be left and resumed

/// Where a half-finished interview is kept.
pub fn session_path(project_root: impl AsRef<Path>) -> PathBuf {
    project_root
        .as_ref()
        .join(".spec-tacular")
        .join("vision-session.json")
}

/// The saved interview, or `None` when there is none or it will not parse.
///
/// A corrupt session is treated as no session: refusing to start over a
/// malformed scratch file would be worse than starting again.
pub fn load_session(project_root: impl AsRef<Path>) -> Option<VisionSession> {
    let raw = fs::read_to_string(session_path(project_root)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_session(project_root: &Path, session: &VisionSession) -> io::Result<()> {
    let path = session_path(project_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(session).map_err(io::Error::other)?;
    fs::write(&path, format!("{json}\n"))
}

/// Records "this is not a new project" — the way out of the vision step.
/// [`crate::core::guide::project_stage`] never offers the vision again.
pub fn skip_session(project_root: impl AsRef<Path>) -> io::Result<()> {
    save_session(
        project_root.as_ref(),
        &VisionSession {
            finished: true,
            skipped: true,
            ..VisionSession::default()
        },
    )
}

// ---------------------------------------------------------------------------
// Prompts

fn option_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "label": { "type": "string" },
            "detail": { "type": "string" },
            "recommended": { "type": "boolean" },
        },
        "required": ["label", "detail", "recommended"],
    })
}

/// What one step of the interview answers in.
pub fn interview_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "understood": { "type": "string" },
            "enough": { "type": "boolean" },
            "question": {
                "type": "object",
                "properties": {
                    "ask": { "type": "string" },
                    "why": { "type": "string" },
                    "options": { "type": "array", "items": option_schema() },
                },
                "required": ["ask", "why", "options"],
            },
        },
        "required": ["understood", "enough", "question"],
    })
}

/// What splitting the vision answers in.
pub fn slices_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "vision": { "type": "string" },
            "slices": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "title": { "type": "string" },
                        "summary": { "type": "string" },
                        "why": { "type": "string" },
                        "dependsOn": { "type": "array", "items": { "type": "string" } },
                    },
                    "required": ["id", "title", "summary", "why", "dependsOn"],
                },
            },
        },
        "required": ["vision", "slices"],
    })
}

/// The ground rules answered so far, so the interview does not re-ask them.
fn ground_rules(project_root: &Path) -> Vec<String> {
    let answered: Vec<String> = guided_questions(project_root)
        .into_iter()
        .filter(|q| q.answered)
        .map(|q| format!("- [{}] {} {}", q.title, q.item.name, one_line(&q.item.text)))
        .collect();
    if answered.is_empty() {
        vec!["(none yet)".to_owned()]
    } else {
        answered
    }
}

/// `/\n+/g → ' '`: every run of newlines becomes one space.
fn one_line(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_break = false;
    for c in text.chars() {
        if c == '\n' {
            if !in_break {
                out.push(' ');
            }
            in_break = true;
        } else {
            out.push(c);
            in_break = false;
        }
    }
    out
}

fn transcript(session: &VisionSession) -> Vec<String> {
    if session.turns.is_empty() {
        return vec!["(no questions asked yet)".to_owned()];
    }
    session
        .turns
        .iter()
        .flat_map(|t| {
            [
                format!("Q: {}", t.ask),
                format!(
                    "A: {}",
                    t.answer
                        .as_deref()
                        .unwrap_or("(skipped — the developer does not know yet)")
                ),
            ]
        })
        .collect()
}

/// One step of the interview: what the model understood, whether it has
/// enough, and the next question.
pub fn build_interview_prompt(project_root: &Path, session: &VisionSession) -> String {
    let mut lines: Vec<String> = [
        "A developer is starting a new software project from nothing. Interview them",
        "about their vision until you understand it well enough to split it into a",
        "sequence of small slices, each one a change that is proposed, specified,",
        "designed and built on its own.",
        "",
        "Their vision, in their words:",
    ]
    .map(str::to_owned)
    .to_vec();
    lines.push(session.vision.clone());
    lines.push(String::new());
    lines.push("Ground rules already settled (never ask about these):".to_owned());
    lines.extend(ground_rules(project_root));
    lines.push(String::new());
    lines.push("The interview so far:".to_owned());
    lines.extend(transcript(session));
    lines.extend(
        [
            "",
            "understood: restate the vision as you now understand it, in 2 to 4 plain",
            "sentences, so the developer can see whether you got it right.",
            "",
            "enough: true once you could split the vision into slices with confidence —",
            "who uses it, the core things they do, what the first usable version must",
            "do, and what is out of scope are clear. Prefer ending early to asking",
            "about details a later change can settle.",
            "",
            "question: when not enough, the single most important unknown, as one",
            "concrete question a developer can answer from what they want — about",
            "users, what they do, what comes first, what is out of scope, constraints",
            "such as data, integrations or platforms. Never technology already settled.",
            "Offer 2 to 5 options where natural (short label, one-line detail, exactly",
            "one recommended); none for questions only they can answer. \"why\" says in",
            "one line what the answer decides. When enough, return an empty ask.",
        ]
        .map(str::to_owned),
    );
    lines.join("\n")
}

/// Splitting the vision into an ordered roadmap of slices.
pub fn build_slices_prompt(project_root: &Path, session: &VisionSession) -> String {
    let mut lines: Vec<String> = [
        "Split a new project into slices: an ordered roadmap where each slice becomes",
        "one change (proposal, specs, design, tasks) built and reviewed on its own.",
        "",
        "The vision, in the developer's words:",
    ]
    .map(str::to_owned)
    .to_vec();
    lines.push(session.vision.clone());
    lines.push(String::new());
    lines.push("As understood after interviewing them:".to_owned());
    lines.push(if session.understood.is_empty() {
        "(no interview)".to_owned()
    } else {
        session.understood.clone()
    });
    lines.push(String::new());
    lines.push("The interview:".to_owned());
    lines.extend(transcript(session));
    lines.push(String::new());
    lines.push("Ground rules:".to_owned());
    lines.extend(ground_rules(project_root));
    lines.extend(
        [
            "",
            "vision: one paragraph, in plain words, of what is being built and for whom.",
            "",
            "slices: 3 to 8, in build order. The first is the smallest thing a user can",
            "actually do end to end; each later one adds one capability a user would",
            "notice. Each small enough to review in one sitting. No slice that is only",
            "setup or infrastructure — fold that into the first slice that needs it.",
            "  id: kebab-case, 2 to 4 words, verb first (add-user-login); it becomes the",
            "      change name.",
            "  title: a few words.",
            "  summary: one sentence — what a user can do once it lands.",
            "  why: one line — why it comes at this point in the order.",
            "  dependsOn: ids of earlier slices it needs.",
        ]
        .map(str::to_owned),
    );
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// Parsing

/// One step of the interview, as the model answered it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InterviewStep {
    pub understood: String,
    pub enough: bool,
    /// `None` when it has enough.
    pub question: Option<InterviewQuestion>,
}

/// What the model said. Anything malformed means "enough": an interview that
/// cannot continue should end, not loop.
pub fn parse_interview(raw: &Value) -> InterviewStep {
    let Some(record) = raw.as_object() else {
        return InterviewStep {
            enough: true,
            ..InterviewStep::default()
        };
    };
    let empty = serde_json::Map::new();
    let q = record
        .get("question")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let ask = text_of(q.get("ask"));
    let enough = record.get("enough") == Some(&Value::Bool(true)) || ask.is_empty();
    InterviewStep {
        understood: text_of(record.get("understood")),
        enough,
        question: (!enough).then(|| InterviewQuestion {
            ask,
            why: text_of(q.get("why")),
            options: parse_options(q.get("options")),
        }),
    }
}

/// The model's slicing: a paragraph and the slices.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Slicing {
    pub vision: String,
    pub slices: Vec<ProposedSlice>,
}

/// `[^a-z0-9]+ → -`, lowercased, dashes trimmed: an id OpenSpec may accept.
fn slug(id: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in id.trim().to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    out.trim_matches('-').to_owned()
}

/// Slices OpenSpec can name, unique (also against `taken`), depending only
/// on slices before them.
pub fn parse_slices(raw: &Value, taken: &[String]) -> Slicing {
    let Some(record) = raw.as_object() else {
        return Slicing::default();
    };
    let mut seen: Vec<String> = taken.to_vec();
    let mut slices: Vec<ProposedSlice> = Vec::new();
    for s in records(record.get("slices")) {
        let id = slug(&text_of(s.get("id")));
        if validate_change_name(&id).is_some() {
            continue;
        }
        let id = unique(&id, &seen);
        let depends_on = s
            .get("dependsOn")
            .and_then(Value::as_array)
            .map(|deps| {
                deps.iter()
                    .map(|d| match d {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    })
                    .filter(|d| slices.iter().any(|x| &x.id == d))
                    .collect()
            })
            .unwrap_or_default();
        let title = text_of(s.get("title"));
        slices.push(ProposedSlice {
            title: if title.is_empty() { id.clone() } else { title },
            summary: text_of(s.get("summary")),
            why: text_of(s.get("why")),
            depends_on,
            id: id.clone(),
        });
        seen.push(id);
    }
    Slicing {
        vision: text_of(record.get("vision")),
        slices,
    }
}

// ---------------------------------------------------------------------------
// Writing the result

/// The vision as agents read it: the refined paragraph, then the interview.
pub fn render_vision(vision: &str, session: &VisionSession) -> String {
    let mut lines: Vec<String> = vec![
        "# Vision".to_owned(),
        String::new(),
        if vision.is_empty() {
            session.vision.clone()
        } else {
            vision.to_owned()
        },
        String::new(),
    ];
    if !session.understood.is_empty() && vision != session.vision {
        lines.extend([
            "## In the developer's words".to_owned(),
            String::new(),
            session.vision.clone(),
            String::new(),
        ]);
    }
    let answered: Vec<(&str, &str)> = session
        .turns
        .iter()
        .filter_map(|t| t.answer.as_deref().map(|a| (t.ask.as_str(), a)))
        .collect();
    if !answered.is_empty() {
        lines.extend(["## Interview".to_owned(), String::new()]);
        for (ask, answer) in answered {
            lines.extend([
                format!("**{ask}**"),
                String::new(),
                answer.to_owned(),
                String::new(),
            ]);
        }
    }
    lines.join("\n")
}

/// `<project>/spec-tacular/vision.md` — what every agent's context leads with.
pub fn vision_path(project_root: impl AsRef<Path>) -> PathBuf {
    project_root.as_ref().join("spec-tacular").join("vision.md")
}

/// Writes the vision and the roadmap, and makes the first slice active.
/// Returns that slice, whose change the caller then creates — `None` when no
/// kept slice can start first.
pub fn finalize_vision(
    project_root: &Path,
    session: &VisionSession,
    vision: &str,
    kept: &[ProposedSlice],
) -> io::Result<Option<Slice>> {
    let path = vision_path(project_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, render_vision(vision, session))?;

    // A dropped slice cannot be depended on.
    let ids: Vec<&str> = kept.iter().map(|s| s.id.as_str()).collect();
    let roadmap = Roadmap {
        vision: if vision.is_empty() {
            session.vision.clone()
        } else {
            vision.to_owned()
        },
        slices: kept
            .iter()
            .map(|s| Slice {
                id: s.id.clone(),
                summary: format!("{}: {}", s.title, s.summary),
                status: SliceStatus::Planned,
                depends_on: s
                    .depends_on
                    .iter()
                    .filter(|d| ids.contains(&d.as_str()))
                    .cloned()
                    .collect(),
            })
            .collect(),
    };
    let Some(first) = roadmap.slices.iter().find(|s| s.depends_on.is_empty()) else {
        save_roadmap(project_root, &roadmap)?;
        return Ok(None);
    };
    match promote_slice(&roadmap, &first.id) {
        SliceChange::Changed { slice, roadmap } => {
            save_roadmap(project_root, &roadmap)?;
            Ok(Some(slice))
        }
        SliceChange::Refused { .. } => {
            save_roadmap(project_root, &roadmap)?;
            Ok(None)
        }
    }
}

/// A change's description, from its slice: what, then why it comes now.
pub fn slice_description(slice: &ProposedSlice) -> String {
    let mut parts = vec![format!("{}: {}", slice.title, slice.summary)];
    if !slice.why.is_empty() {
        parts.push(format!("Why now: {}", slice.why));
    }
    parts.join("\n\n")
}

// ---------------------------------------------------------------------------
// The interviewer

fn saved(root: &Path, session: &VisionSession) -> Result<(), String> {
    save_session(root, session).map_err(|error| format!("Could not save the interview: {error}"))
}

/// See the module docs. Cheap to clone: a path and a shared `ask`.
///
/// Every step re-reads the saved session and saves it again before
/// returning, so what is on disk is always where the interview is — quitting
/// mid-question loses nothing.
#[derive(Clone)]
pub struct VisionInterviewer {
    root: PathBuf,
    ask: Ask,
}

impl VisionInterviewer {
    pub fn new(project_root: impl Into<PathBuf>, ask: Ask) -> Self {
        Self {
            root: project_root.into(),
            ask,
        }
    }

    pub fn session(&self) -> Option<VisionSession> {
        load_session(&self.root)
    }

    /// Not a new project: never offer the vision interview here again.
    pub fn skip(&self) -> Result<VisionSession, String> {
        skip_session(&self.root).map_err(|error| format!("Could not save that: {error}"))?;
        Ok(self.session().unwrap_or_default())
    }

    /// Starts from the developer's own description, and asks the first
    /// question.
    pub async fn start(&self, vision: &str) -> Result<VisionSession, String> {
        let session = VisionSession {
            vision: vision.trim().to_owned(),
            ..VisionSession::default()
        };
        saved(&self.root, &session)?;
        self.next(session).await
    }

    /// Keeps the description as the vision without an interview — for when
    /// there is no model to run one — and says this is not a vision to
    /// interview about again: the project goes on to a single change.
    pub fn keep_without_interview(&self, vision: &str) -> Result<VisionSession, String> {
        let session = VisionSession {
            vision: vision.trim().to_owned(),
            ..VisionSession::default()
        };
        saved(&self.root, &session)?;
        finalize_vision(&self.root, &session, vision.trim(), &[])
            .map_err(|error| format!("Could not save the vision: {error}"))?;
        self.skip()
    }

    /// Records an answer (`None`: skipped) and asks the next question.
    pub async fn answer(&self, text: Option<&str>) -> Result<VisionSession, String> {
        let mut session = self.session().unwrap_or_default();
        let Some(pending) = session.pending.take() else {
            return Err("No question is waiting for an answer".to_owned());
        };
        session.turns.push(VisionTurn {
            ask: pending.ask,
            answer: text.map(str::to_owned),
        });
        saved(&self.root, &session)?;
        self.next(session).await
    }

    /// Asks again after a failure, or after quitting while it was thinking.
    pub async fn resume(&self) -> Result<VisionSession, String> {
        let session = self
            .session()
            .filter(|s| !s.vision.is_empty())
            .ok_or_else(|| "No vision yet".to_owned())?;
        if session.pending.is_some() || session.finished {
            return Ok(session);
        }
        self.next(session).await
    }

    /// The developer has said enough.
    pub fn finish(&self) -> Result<VisionSession, String> {
        let mut session = self.session().ok_or_else(|| "No vision yet".to_owned())?;
        session.pending = None;
        session.finished = true;
        saved(&self.root, &session)?;
        Ok(session)
    }

    async fn next(&self, mut session: VisionSession) -> Result<VisionSession, String> {
        if session.turns.len() >= MAX_TURNS {
            return self.finish();
        }
        let prompt = build_interview_prompt(&self.root, &session);
        let step = parse_interview(&(self.ask)(prompt, interview_schema()).await?);
        if !step.understood.is_empty() {
            session.understood = step.understood;
        }
        session.pending = step.question;
        session.finished = step.enough;
        saved(&self.root, &session)?;
        Ok(session)
    }

    /// Splits the vision into slices, for the developer to review; the
    /// session with them.
    pub async fn extract(&self, taken: &[String]) -> Result<VisionSession, String> {
        let mut session = self.session().ok_or_else(|| "No vision yet".to_owned())?;
        let prompt = build_slices_prompt(&self.root, &session);
        let result = parse_slices(&(self.ask)(prompt, slices_schema()).await?, taken);
        session.slices = result.slices;
        session.refined = Some(result.vision);
        saved(&self.root, &session)?;
        Ok(session)
    }

    /// Writes the vision and the roadmap from the slices kept, and makes the
    /// first one active — see [`finalize_vision`].
    pub fn confirm(&self, vision: &str, kept: &[ProposedSlice]) -> Result<Option<Slice>, String> {
        let session = self.session().unwrap_or_default();
        finalize_vision(&self.root, &session, vision, kept)
            .map_err(|error| format!("Could not write the roadmap: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::context::{build_context, render_context};
    use crate::core::roadmap::load_roadmap;
    use std::future::Future;
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;

    fn root() -> TempDir {
        let dir = TempDir::new().expect("temp dir");
        fs::create_dir_all(dir.path().join("openspec/changes")).expect("changes");
        dir
    }

    fn block_on<T>(work: impl Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime")
            .block_on(work)
    }

    fn slice(id: &str, depends_on: &[&str]) -> ProposedSlice {
        ProposedSlice {
            id: id.to_owned(),
            title: id.to_owned(),
            summary: format!("do {id}"),
            why: String::new(),
            depends_on: depends_on.iter().map(|d| (*d).to_owned()).collect(),
        }
    }

    /// A model that always asks another question, numbered, recording every
    /// prompt it is sent.
    fn asking(prompts: Arc<Mutex<Vec<String>>>) -> Ask {
        Arc::new(move |prompt, _schema| {
            let n = {
                let mut seen = prompts.lock().expect("prompts");
                seen.push(prompt);
                seen.len()
            };
            Box::pin(async move {
                Ok(json!({
                    "understood": "u",
                    "enough": false,
                    "question": { "ask": format!("Q{n}?"), "why": "", "options": [] },
                }))
            })
        })
    }

    // --- greenfield ----------------------------------------------------------

    #[test]
    fn a_project_with_no_specs_and_no_archive_is_greenfield() {
        let dir = TempDir::new().expect("temp dir");
        fs::create_dir_all(dir.path().join("openspec/specs")).expect("specs");
        assert!(is_greenfield(dir.path()));
    }

    #[test]
    fn a_spec_anywhere_under_specs_ends_it() {
        let dir = TempDir::new().expect("temp dir");
        fs::create_dir_all(dir.path().join("openspec/specs/auth/nested")).expect("specs");
        fs::write(
            dir.path().join("openspec/specs/auth/nested/spec.md"),
            "# Auth\n",
        )
        .expect("spec");
        assert!(!is_greenfield(dir.path()));
    }

    #[test]
    fn an_archived_change_ends_it_too() {
        let dir = TempDir::new().expect("temp dir");
        fs::create_dir_all(dir.path().join("openspec/changes/archive/old")).expect("archive");
        assert!(!is_greenfield(dir.path()));
    }

    #[test]
    fn a_skipped_session_round_trips() {
        let dir = TempDir::new().expect("temp dir");
        assert!(load_session(dir.path()).is_none());
        skip_session(dir.path()).expect("skip");
        assert!(load_session(dir.path()).expect("session").skipped);
    }

    #[test]
    fn a_skipped_session_is_written_as_the_typescript_wrote_it() {
        let dir = TempDir::new().expect("temp dir");
        skip_session(dir.path()).expect("skip");
        let written: Value =
            serde_json::from_str(&fs::read_to_string(session_path(dir.path())).expect("read"))
                .expect("json");
        assert_eq!(
            written,
            json!({
                "vision": "", "turns": [], "understood": "", "pending": null,
                "finished": true, "slices": [], "skipped": true,
            })
        );
    }

    #[test]
    fn a_session_the_typescript_wrote_resumes_here() {
        let dir = TempDir::new().expect("temp dir");
        fs::create_dir_all(dir.path().join(".spec-tacular")).expect("dir");
        fs::write(
            session_path(dir.path()),
            r#"{"vision":"v","turns":[{"ask":"Who?","answer":null}],"understood":"u",
                "pending":{"ask":"What?","why":"w","options":[{"label":"a","detail":"d","recommended":true}]},
                "finished":false,"slices":[{"id":"x","title":"X","summary":"s","why":"","dependsOn":[]}]}"#,
        )
        .expect("write");
        let session = load_session(dir.path()).expect("session");
        assert_eq!(session.turns[0].answer, None);
        assert_eq!(session.pending.expect("pending").options[0].label, "a");
        assert_eq!(session.slices[0].id, "x");
        assert!(!session.skipped);
    }

    #[test]
    fn a_corrupt_session_reads_as_none_rather_than_failing() {
        let dir = TempDir::new().expect("temp dir");
        fs::create_dir_all(dir.path().join(".spec-tacular")).expect("dir");
        fs::write(session_path(dir.path()), "{ not json").expect("write");
        assert!(load_session(dir.path()).is_none());
    }

    // --- the interview -------------------------------------------------------

    #[test]
    fn an_empty_question_means_enough_whatever_the_flag_says() {
        assert_eq!(
            parse_interview(&json!({
                "understood": "u", "enough": false,
                "question": { "ask": "", "why": "", "options": [] },
            })),
            InterviewStep {
                understood: "u".to_owned(),
                enough: true,
                question: None,
            }
        );
        assert!(parse_interview(&Value::Null).enough);
    }

    #[test]
    fn records_answers_and_skips_and_carries_them_into_the_next_prompt() {
        let r = root();
        let prompts = Arc::new(Mutex::new(Vec::new()));
        let interviewer = VisionInterviewer::new(r.path(), asking(Arc::clone(&prompts)));
        let session = block_on(async {
            interviewer.start("A clinic booking tool").await?;
            interviewer.answer(Some("Receptionists")).await?;
            interviewer.answer(None).await
        })
        .expect("interview");

        assert_eq!(
            session.turns,
            vec![
                VisionTurn {
                    ask: "Q1?".to_owned(),
                    answer: Some("Receptionists".to_owned()),
                },
                VisionTurn {
                    ask: "Q2?".to_owned(),
                    answer: None,
                },
            ]
        );
        let prompts = prompts.lock().expect("prompts");
        assert!(
            prompts[2].contains("Q: Q1?\nA: Receptionists"),
            "{}",
            prompts[2]
        );
        assert!(prompts[2].contains("Q: Q2?\nA: (skipped"), "{}", prompts[2]);
        assert_eq!(session.pending.expect("pending").ask, "Q3?");
    }

    #[test]
    fn stops_asking_after_the_cap_however_unsure_the_model_is() {
        let r = root();
        let interviewer =
            VisionInterviewer::new(r.path(), asking(Arc::new(Mutex::new(Vec::new()))));
        let mut session = block_on(interviewer.start(&"x".repeat(20))).expect("start");
        for _ in 0..MAX_TURNS {
            session = block_on(interviewer.answer(Some("yes"))).expect("answer");
        }
        assert!(session.finished);
        assert_eq!(session.pending, None);
    }

    #[test]
    fn the_prompt_never_asks_about_settled_ground_rules() {
        let r = root();
        let prompt = build_interview_prompt(
            r.path(),
            &VisionSession {
                vision: "V".to_owned(),
                ..VisionSession::default()
            },
        );
        assert!(prompt.contains("Ground rules already settled (never ask about these)"));
        assert!(prompt.contains("Prefer ending early"));
    }

    #[test]
    fn a_failed_request_leaves_the_session_to_be_resumed() {
        let r = root();
        let failing: Ask = Arc::new(|_, _| Box::pin(async { Err("offline".to_owned()) }));
        let interviewer = VisionInterviewer::new(r.path(), failing);
        assert_eq!(
            block_on(interviewer.start("A clinic booking tool")),
            Err("offline".to_owned())
        );
        // The description is kept; nothing is waiting, nothing is finished —
        // which is the "ask again" state.
        let session = interviewer.session().expect("saved");
        assert_eq!(session.vision, "A clinic booking tool");
        assert!(session.pending.is_none() && !session.finished);

        let again = VisionInterviewer::new(r.path(), asking(Arc::new(Mutex::new(Vec::new()))));
        let resumed = block_on(again.resume()).expect("resume");
        assert_eq!(resumed.pending.expect("asked").ask, "Q1?");
    }

    #[test]
    fn answering_with_nothing_pending_is_refused() {
        let r = root();
        let interviewer =
            VisionInterviewer::new(r.path(), asking(Arc::new(Mutex::new(Vec::new()))));
        assert!(block_on(interviewer.answer(Some("x"))).is_err());
    }

    // --- slices --------------------------------------------------------------

    #[test]
    fn only_valid_unique_names_depending_only_on_earlier_slices() {
        let slicing = parse_slices(
            &json!({
                "vision": "v",
                "slices": [
                    { "id": "Book A Room", "title": "Book", "summary": "s", "why": "w", "dependsOn": ["see-week"] },
                    { "id": "see-week", "title": "See", "summary": "s", "why": "w", "dependsOn": ["book-a-room", "nope"] },
                    { "id": "see-week", "title": "Again", "summary": "s", "why": "w", "dependsOn": [] },
                    { "id": "!!!", "title": "Bad", "summary": "s", "why": "w", "dependsOn": [] },
                ],
            }),
            &["taken".to_owned()],
        );
        let shape: Vec<(&str, Vec<&str>)> = slicing
            .slices
            .iter()
            .map(|s| {
                (
                    s.id.as_str(),
                    s.depends_on.iter().map(String::as_str).collect(),
                )
            })
            .collect();
        assert_eq!(
            shape,
            vec![
                ("book-a-room", vec![]),
                ("see-week", vec!["book-a-room"]),
                ("see-week-2", vec![]),
            ]
        );
        assert_eq!(parse_slices(&Value::Null, &[]), Slicing::default());
    }

    #[test]
    fn finalizing_writes_the_vision_and_roadmap_and_activates_the_first_slice() {
        let r = root();
        let session = VisionSession {
            vision: "my words".to_owned(),
            turns: vec![
                VisionTurn {
                    ask: "Who?".to_owned(),
                    answer: Some("Staff".to_owned()),
                },
                VisionTurn {
                    ask: "Skipped?".to_owned(),
                    answer: None,
                },
            ],
            understood: "u".to_owned(),
            finished: true,
            ..VisionSession::default()
        };
        let first = finalize_vision(
            r.path(),
            &session,
            "The refined vision.",
            &[
                slice("book-room", &[]),
                slice("see-week", &["book-room", "dropped-one"]),
            ],
        )
        .expect("finalize");
        assert_eq!(first.expect("a first slice").id, "book-room");
        let roadmap = load_roadmap(r.path()).expect("roadmap");
        assert_eq!(roadmap.vision, "The refined vision.");
        let shape: Vec<(&str, SliceStatus, Vec<String>)> = roadmap
            .slices
            .iter()
            .map(|s| (s.id.as_str(), s.status, s.depends_on.clone()))
            .collect();
        assert_eq!(
            shape,
            vec![
                ("book-room", SliceStatus::Active, vec![]),
                (
                    "see-week",
                    SliceStatus::Planned,
                    vec!["book-room".to_owned()]
                ),
            ]
        );

        let vision = fs::read_to_string(vision_path(r.path())).expect("vision.md");
        assert!(vision.contains("The refined vision."));
        assert!(vision.contains("## In the developer's words\n\nmy words"));
        assert!(vision.contains("**Who?**\n\nStaff"));
        assert!(!vision.contains("Skipped?"));

        // And every agent now reads it.
        let context = render_context(&build_context(r.path(), &[]));
        assert!(context.contains("# Product vision"), "{context}");
        assert!(context.contains("The refined vision."), "{context}");
    }

    #[test]
    fn a_slice_description_says_what_then_why_now() {
        let mut s = slice("book-a-room", &[]);
        s.title = "Book a room".to_owned();
        s.summary = "A receptionist books a free room.".to_owned();
        s.why = "The core of it".to_owned();
        assert_eq!(
            slice_description(&s),
            "Book a room: A receptionist books a free room.\n\nWhy now: The core of it"
        );
        s.why.clear();
        assert_eq!(
            slice_description(&s),
            "Book a room: A receptionist books a free room."
        );
    }

    #[test]
    fn keeping_the_vision_without_a_model_writes_it_and_moves_on_to_a_change() {
        let r = root();
        let failing: Ask = Arc::new(|_, _| Box::pin(async { Err("no model".to_owned()) }));
        let interviewer = VisionInterviewer::new(r.path(), failing);
        let session = interviewer
            .keep_without_interview("  A booking tool for clinics.  ")
            .expect("kept");
        assert!(session.skipped);
        let vision = fs::read_to_string(vision_path(r.path())).expect("vision.md");
        assert!(vision.contains("A booking tool for clinics."));
        assert!(load_roadmap(r.path()).expect("roadmap").slices.is_empty());
    }
}
