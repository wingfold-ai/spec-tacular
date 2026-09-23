//! The Foundation advisor: an AI that digs deeper where an answer leaves a
//! decision open, and proposes options for the questions still ahead.
//!
//! "Python" is not a stack — it leaves the version, the package manager and the
//! test runner undecided, and whatever the first change's agent picks for them
//! becomes an accident every later change inherits. The static questions cannot
//! know which follow-ups an answer needs; a model that sees the answer can.
//!
//! Two rules keep it honest:
//!   - It proposes, it never decides. Options are shown with one marked
//!     recommended, but nothing is written until a human picks one or types
//!     their own. The Foundation still holds only decisions somebody made.
//!   - It runs in the background. Setup never waits on it; a follow-up that
//!     arrives late is simply the next question.
//!
//! The model is reached through an injected [`Ask`], so this module knows
//! nothing about which agent answers — and is tested without one. The whole
//! of the TypeScript `core/advisor.ts` is here: the types, the prompts, the
//! parsers, the sidecar and the follow-ups written into the Foundation files.
//! What stage 8 adds is the other end of `Ask` — a driver's structured
//! request — and the TUI's real ports handing it to a [`FoundationAdvisor`].

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::foundation::{guided_questions, GuidedQuestion};
use super::markdown::{build_code_fence_mask, normalized_lines, SECTION_HEADER};
use super::requirements::slugify;

/// One proposed answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdviceOption {
    /// The answer itself, as it would be written: `uv`, `3.14`.
    pub label: String,
    /// One line: why, or the trade-off.
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub recommended: bool,
}

/// A question the model thinks an answer left open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FollowUp {
    pub ask: String,
    /// Why this matters, shown as the question's hint.
    pub why: String,
    pub options: Vec<AdviceOption>,
}

/// An answer to a later question that already follows from earlier ones.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Derived {
    /// The open question, exactly as asked.
    pub question: String,
    pub answer: String,
    /// Which earlier answer it follows from, in one line.
    pub reason: String,
}

/// What the model said about an answer.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Advice {
    pub follow_ups: Vec<FollowUp>,
    /// Options for the next question, when it is one a model can help with.
    pub upcoming: Vec<AdviceOption>,
    pub derived: Vec<Derived>,
}

/// Help for a question the developer does not know how to answer.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Coaching {
    /// What the question means and why it matters, in plain words.
    pub explain: String,
    /// Concrete answers for this project, to pick from or adapt.
    pub examples: Vec<AdviceOption>,
    /// Simpler questions whose answers would settle this one.
    pub probes: Vec<FollowUp>,
}

/// A derived answer as remembered: proposed, not yet confirmed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DerivedAnswer {
    pub answer: String,
    pub reason: String,
}

/// What spec-tacular remembers about a question beyond its Markdown section.
///
/// Stored as the TypeScript stored it — camelCase JSON, absent fields left
/// out — so a project can be opened by either.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QuestionMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<AdviceOption>>,
    /// The question was asked about, even if it came back with no options.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested: Option<bool>,
    /// Set on a follow-up: the question whose answer raised it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    /// 0 for the scaffold's questions; follow-ups are one deeper than their
    /// parent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth: Option<usize>,
    /// Set on a simpler question added to help decide another: that question.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub helps: Option<String>,
    /// Proposed from earlier answers; shown first, confirmed by the developer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derived: Option<DerivedAnswer>,
    /// Plain-words explanation, from asking for help.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explain: Option<String>,
}

impl QuestionMeta {
    /// `{ ...self, ...patch }`: every field the patch sets wins.
    fn merge(&mut self, patch: QuestionMeta) {
        macro_rules! take {
            ($($field:ident),*) => {$(
                if patch.$field.is_some() {
                    self.$field = patch.$field;
                }
            )*};
        }
        take!(options, suggested, parent, why, depth, helps, derived, explain);
    }

    pub fn is_suggested(&self) -> bool {
        self.suggested == Some(true)
    }

    /// Whether the advisor added it — a follow-up or a simpler question —
    /// and so whether it may be dismissed.
    pub fn is_added(&self) -> bool {
        self.parent.is_some() || self.helps.is_some()
    }
}

/// Every question's meta, by question id.
pub type Meta = BTreeMap<String, QuestionMeta>;

/// What advising on an answer did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AfterAnswer {
    /// Follow-ups written into the Foundation, after the answered question.
    pub added: Vec<FollowUp>,
    /// Names of later questions an answer was derived for.
    pub derived: Vec<String>,
}

/// What asking for help did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Coached {
    pub explain: String,
    /// Simpler questions written into the Foundation, before the hard one.
    pub probes: Vec<FollowUp>,
}

/// How far follow-ups may nest. Past this, an answer is detailed enough.
pub const MAX_DEPTH: usize = 2;
const MAX_FOLLOW_UPS: usize = 3;
const MAX_OPTIONS: usize = 5;

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

fn follow_up_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "ask": { "type": "string" },
            "why": { "type": "string" },
            "options": { "type": "array", "items": option_schema() },
        },
        "required": ["ask", "why", "options"],
    })
}

/// The JSON Schema the model must answer advice in.
pub fn advice_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "followUps": { "type": "array", "items": follow_up_schema() },
            "upcoming": { "type": "array", "items": option_schema() },
            "derived": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "question": { "type": "string" },
                        "answer": { "type": "string" },
                        "reason": { "type": "string" },
                    },
                    "required": ["question", "answer", "reason"],
                },
            },
        },
        "required": ["followUps", "upcoming", "derived"],
    })
}

/// The JSON Schema the model must answer a request for help in.
pub fn coach_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "explain": { "type": "string" },
            "examples": { "type": "array", "items": option_schema() },
            "probes": { "type": "array", "items": follow_up_schema() },
        },
        "required": ["explain", "examples", "probes"],
    })
}

/// What one advice prompt is about.
#[derive(Debug, Clone, Copy)]
pub struct AdviceRequest<'a> {
    /// Every question so far, answered or not, so nothing is asked twice.
    pub questions: &'a [GuidedQuestion],
    /// The answer that was just given, if any, and how deep its question is.
    pub answered: Option<(&'a GuidedQuestion, &'a str, usize)>,
    /// The question to propose options for, if any.
    pub upcoming: Option<&'a GuidedQuestion>,
}

/// What every advisor prompt starts with: the project as decided so far.
fn preamble(questions: &[GuidedQuestion]) -> Vec<String> {
    let decided: Vec<String> = questions
        .iter()
        .filter(|q| q.answered)
        .map(|q| {
            let text = q
                .item
                .text
                .split('\n')
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            format!("- [{}] {}\n  {text}", q.title, q.item.name)
        })
        .collect();
    let open: Vec<String> = questions
        .iter()
        .filter(|q| !q.answered)
        .map(|q| format!("- [{}] {}", q.title, q.item.name))
        .collect();
    let mut lines: Vec<String> = [
        "You are helping a developer settle the ground rules of a software project",
        "before any code is written: its stack, domain, architecture and conventions.",
        "Every coding agent that works on the project later reads these answers.",
        "",
        "Decided so far:",
    ]
    .map(str::to_owned)
    .to_vec();
    if decided.is_empty() {
        lines.push("(nothing yet)".to_owned());
    } else {
        lines.extend(decided);
    }
    lines.push(String::new());
    lines.push("Still open (never ask these again):".to_owned());
    if open.is_empty() {
        lines.push("(none)".to_owned());
    } else {
        lines.extend(open);
    }
    lines.push(String::new());
    lines
}

fn option_rules() -> [String; 7] {
    [
        format!("Options: 2 to {MAX_OPTIONS}, best first, exactly one with recommended: true. A label is"),
        "the literal answer, short (for example \"uv\", \"3.14\", \"pytest\"); the detail is one".to_owned(),
        "line on why or the trade-off. Prefer what is current state of the art. For".to_owned(),
        "versions, recommend the most recent stable release — look it up with web search".to_owned(),
        "rather than relying on memory, and never propose a pre-release. A question's".to_owned(),
        "\"ask\" is the question text alone, with no [Section] prefix; its \"why\" says in".to_owned(),
        "one line what depends on the decision. Keep every detail under 70 characters.".to_owned(),
    ]
}

/// The prompt that asks for follow-ups on an answer, options for the next
/// question and answers that now follow — in one request.
pub fn build_advice_prompt(request: &AdviceRequest<'_>) -> String {
    let mut lines = preamble(request.questions);

    if let Some((question, answer, depth)) = request.answered {
        lines.push(format!(
            "Just answered — [{}] {}",
            question.title, question.item.name
        ));
        lines.push(format!("Answer: {answer}"));
        lines.push(String::new());
        lines.push(if depth >= MAX_DEPTH {
            "followUps: return an empty list — this answer is already a follow-up of a follow-up."
                .to_owned()
        } else {
            [
                "followUps: questions that dig deeper into THIS answer, only where it leaves a",
                "concrete decision open that later work depends on. Examples: a language",
                "without a version; a language without its package manager, test runner or",
                "linter; a datastore without its migration tool; an architecture style without",
                "where its boundaries sit. Return an empty list when the answer is already",
                &format!(
                    "specific enough. At most {MAX_FOLLOW_UPS}. Never repeat a question listed above."
                ),
            ]
            .join("\n")
        });
        lines.push(String::new());
    } else {
        lines.push("followUps: return an empty list.".to_owned());
        lines.push(String::new());
    }

    if let Some(upcoming) = request.upcoming {
        lines.push(format!(
            "upcoming: options for the next question — [{}] {}",
            upcoming.title, upcoming.item.name
        ));
        lines.extend(
            [
                "consistent with everything decided so far. Return an empty list when only the",
                "developer can answer it: the project's purpose, its domain terms, its rules,",
                "what is out of scope, or anything about their team.",
                "",
            ]
            .map(str::to_owned),
        );
    } else {
        lines.push("upcoming: return an empty list.".to_owned());
        lines.push(String::new());
    }

    lines.extend(
        [
            "derived: for questions listed under \"Still open\" whose answer already follows",
            "from what is decided — stated outright or clearly implied — propose that answer.",
            "Examples: \"uv\" decided for packages implies nothing about tests, but \"pytest via",
            "uv\" does; \"Clean architecture\" implies business rules live in the domain layer.",
            "Copy the question text exactly, give the answer as it would be written, and a",
            "one-line reason naming the earlier answer it comes from. Only when confident;",
            "the developer confirms each one. Return an empty list otherwise.",
            "",
        ]
        .map(str::to_owned),
    );
    lines.extend(option_rules());
    lines.join("\n")
}

/// For a question the developer does not know how to answer.
pub fn build_coach_prompt(questions: &[GuidedQuestion], question: &GuidedQuestion) -> String {
    let mut lines = preamble(questions);
    lines.push(format!(
        "The developer does not know how to answer — [{}] {}",
        question.title, question.item.name
    ));
    lines.extend(
        [
            "",
            "explain: in two or three short sentences of plain words, what this question is",
            "asking and what later depends on it. No jargon without saying what it means.",
            "",
            "examples: concrete answers that would fit THIS project given what is decided,",
            "as options to pick from or adapt.",
            "",
            "probes: up to 3 simpler questions — ones a developer can answer from what they",
            "want the project to do, without knowing the technical term — whose answers",
            "would let you settle this question for them. Each with options. Return an",
            "empty list when the examples alone are enough to choose from.",
            "",
        ]
        .map(str::to_owned),
    );
    lines.extend(option_rules());
    lines.join("\n")
}

/// `String(value ?? '')`, trimmed: what the TypeScript made of a field that
/// should have been a string.
fn text_of(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.trim().to_owned(),
        Some(other) => other.to_string().trim().to_owned(),
    }
}

/// The records of a list, anything else in it ignored.
fn records(value: Option<&Value>) -> Vec<&serde_json::Map<String, Value>> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_object).collect())
        .unwrap_or_default()
}

/// Models copy the prompt's `[Section] question` prefix into their own
/// questions often enough to strip it.
fn strip_section(text: &str) -> String {
    if let Some(rest) = text.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            return rest[end + 1..].trim_start().to_owned();
        }
    }
    text.to_owned()
}

fn parse_options(raw: Option<&Value>) -> Vec<AdviceOption> {
    let options: Vec<AdviceOption> = records(raw)
        .into_iter()
        .map(|o| AdviceOption {
            label: text_of(o.get("label")),
            detail: text_of(o.get("detail")),
            recommended: o.get("recommended") == Some(&Value::Bool(true)),
        })
        .filter(|o| !o.label.is_empty())
        .take(MAX_OPTIONS)
        .collect();
    // Exactly one recommendation, whatever the model sent: none reads as "no
    // opinion", several as no recommendation at all.
    let first = options.iter().position(|o| o.recommended).unwrap_or(0);
    options
        .into_iter()
        .enumerate()
        .map(|(i, o)| AdviceOption {
            recommended: i == first,
            ..o
        })
        .collect()
}

/// Validates a model's follow-ups. Anything malformed becomes "no advice"
/// rather than an error: the advisor is an aid, and setup must work without
/// it.
fn parse_follow_ups(raw: Option<&Value>) -> Vec<FollowUp> {
    records(raw)
        .into_iter()
        .map(|f| FollowUp {
            ask: strip_section(&text_of(f.get("ask"))),
            why: text_of(f.get("why")),
            options: parse_options(f.get("options")),
        })
        .filter(|f| !f.ask.is_empty())
        .take(MAX_FOLLOW_UPS)
        .collect()
}

/// A model's advice, validated.
pub fn parse_advice(raw: &Value) -> Advice {
    let Some(record) = raw.as_object() else {
        return Advice::default();
    };
    let derived = records(record.get("derived"))
        .into_iter()
        .map(|d| Derived {
            question: strip_section(&text_of(d.get("question"))),
            answer: text_of(d.get("answer")),
            reason: text_of(d.get("reason")),
        })
        .filter(|d| !d.question.is_empty() && !d.answer.is_empty())
        .collect();
    Advice {
        follow_ups: parse_follow_ups(record.get("followUps")),
        upcoming: parse_options(record.get("upcoming")),
        derived,
    }
}

/// A model's help, validated.
pub fn parse_coaching(raw: &Value) -> Coaching {
    let Some(record) = raw.as_object() else {
        return Coaching::default();
    };
    Coaching {
        explain: text_of(record.get("explain")),
        examples: parse_options(record.get("examples")),
        probes: parse_follow_ups(record.get("probes")),
    }
}

// ---------------------------------------------------------------------------
// What is remembered between runs

pub fn meta_path(project_root: impl AsRef<Path>) -> PathBuf {
    project_root
        .as_ref()
        .join(".spec-tacular")
        .join("foundation-advice.json")
}

/// The advisor's memory. Missing or unreadable is empty: it is an aid.
pub fn load_meta(project_root: impl AsRef<Path>) -> Meta {
    fs::read_to_string(meta_path(project_root))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| {
            let record = value.as_object()?;
            // One malformed entry is dropped, not the whole memory.
            Some(
                record
                    .iter()
                    .filter_map(|(id, meta)| {
                        serde_json::from_value::<QuestionMeta>(meta.clone())
                            .ok()
                            .map(|meta| (id.clone(), meta))
                    })
                    .collect(),
            )
        })
        .unwrap_or_default()
}

fn save_meta(project_root: &Path, meta: &Meta) -> Result<(), String> {
    let path = meta_path(project_root);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Could not write {}: {e}", dir.display()))?;
    }
    let body = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    fs::write(&path, format!("{body}\n"))
        .map_err(|e| format!("Could not write {}: {e}", path.display()))
}

fn update_meta(project_root: &Path, id: &str, patch: QuestionMeta) -> Result<(), String> {
    let mut meta = load_meta(project_root);
    meta.entry(id.to_owned()).or_default().merge(patch);
    save_meta(project_root, &meta)
}

// ---------------------------------------------------------------------------
// Writing follow-ups into the Foundation

/// Where follow-ups go relative to the question they are about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Place {
    /// Straight after it: they dig into its answer.
    After,
    /// Straight before it: simpler questions that help decide it, answered
    /// before it comes round again.
    Before,
}

/// The line index of `name`'s `##` heading.
fn heading_index(lines: &[String], mask: &[bool], name: &str) -> Option<usize> {
    (0..lines.len()).find(|&i| {
        !mask[i]
            && SECTION_HEADER.is_match(&lines[i])
            && SECTION_HEADER.replace(&lines[i], "").trim() == name
    })
}

/// Inserts follow-ups as new sections next to their parent, each left `TBD`
/// like any scaffolded question. Returns the ones written — a question that
/// already exists is never asked twice.
///
/// They go into the Markdown, not only the sidecar: the Foundation files are
/// the source of truth, a follow-up is as much a ground rule as the
/// scaffold's own questions, and it must survive this tool not being
/// installed.
pub fn insert_follow_ups(
    parent: &GuidedQuestion,
    follow_ups: &[FollowUp],
    existing: &[GuidedQuestion],
    place: Place,
) -> Vec<FollowUp> {
    let mut taken: BTreeSet<String> = existing.iter().map(|q| slugify(&q.item.name)).collect();
    let fresh: Vec<FollowUp> = follow_ups
        .iter()
        .filter(|f| taken.insert(slugify(&f.ask)))
        .cloned()
        .collect();
    if fresh.is_empty() {
        return Vec::new();
    }
    let Ok(content) = fs::read_to_string(&parent.item.file) else {
        return Vec::new();
    };
    let lines = normalized_lines(&content);
    let mask = build_code_fence_mask(&lines);
    let Some(start) = heading_index(&lines, &mask, &parent.item.name) else {
        return Vec::new();
    };

    let next: Vec<String> = match place {
        Place::Before => {
            let mut next = lines[..start].to_vec();
            for f in &fresh {
                next.extend([
                    format!("## {}", f.ask),
                    String::new(),
                    "TBD".into(),
                    String::new(),
                ]);
            }
            next.extend_from_slice(&lines[start..]);
            next
        }
        Place::After => {
            let mut end = start + 1;
            while end < lines.len() && (mask[end] || !SECTION_HEADER.is_match(&lines[end])) {
                end += 1;
            }
            // The parent's body ends at its last non-blank line; the blank
            // lines after it are replaced, so the file keeps exactly one blank
            // line between sections.
            let mut last = end - 1;
            while last > start && lines[last].trim().is_empty() {
                last -= 1;
            }
            let mut next = lines[..=last].to_vec();
            for f in &fresh {
                next.extend([
                    String::new(),
                    format!("## {}", f.ask),
                    String::new(),
                    "TBD".into(),
                ]);
            }
            next.push(String::new());
            next.extend_from_slice(&lines[end..]);
            next
        }
    };
    match fs::write(&parent.item.file, next.join("\n")) {
        Ok(()) => fresh,
        Err(_) => Vec::new(),
    }
}

/// Removes a question the advisor added and the developer finds irrelevant.
pub fn remove_question(question: &GuidedQuestion) -> bool {
    let Ok(content) = fs::read_to_string(&question.item.file) else {
        return false;
    };
    let lines = normalized_lines(&content);
    let mask = build_code_fence_mask(&lines);
    let Some(start) = heading_index(&lines, &mask, &question.item.name) else {
        return false;
    };
    let mut end = start + 1;
    while end < lines.len() && (mask[end] || !SECTION_HEADER.is_match(&lines[end])) {
        end += 1;
    }
    let mut next = lines[..start].to_vec();
    next.extend_from_slice(&lines[end..]);
    fs::write(&question.item.file, next.join("\n")).is_ok()
}

// ---------------------------------------------------------------------------
// The advisor

/// What an [`Ask`] returns: the model's structured output, or why there is
/// none.
pub type AskFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>;

/// Sends a prompt with the JSON Schema to answer in; resolves to the model's
/// structured output.
pub type Ask = Arc<dyn Fn(String, Value) -> AskFuture + Send + Sync>;

/// See the module docs. Cheap to clone: a path and a shared `ask`.
#[derive(Clone)]
pub struct FoundationAdvisor {
    root: PathBuf,
    ask: Ask,
}

impl FoundationAdvisor {
    pub fn new(project_root: impl Into<PathBuf>, ask: Ask) -> Self {
        Self {
            root: project_root.into(),
            ask,
        }
    }

    pub fn meta(&self) -> Meta {
        load_meta(&self.root)
    }

    /// The next open question with no advice yet — what to prefetch.
    fn next_unadvised<'a>(
        &self,
        after: &GuidedQuestion,
        questions: &'a [GuidedQuestion],
    ) -> Option<&'a GuidedQuestion> {
        let meta = self.meta();
        let from = questions
            .iter()
            .position(|q| q.item.id == after.item.id)
            .map_or(0, |i| i + 1);
        questions[from.min(questions.len())..]
            .iter()
            .find(|q| !q.answered && !meta.get(&q.item.id).is_some_and(QuestionMeta::is_suggested))
    }

    /// Records meta for questions just written into the files, found by name —
    /// their ids are only known once the sections exist.
    fn record_added(
        &self,
        file: &str,
        added: &[FollowUp],
        patch: impl Fn(&FollowUp) -> QuestionMeta,
    ) -> Result<(), String> {
        let after = guided_questions(&self.root);
        for f in added {
            if let Some(q) = after
                .iter()
                .find(|x| x.item.name == f.ask && x.item.file == file)
            {
                let mut meta = QuestionMeta {
                    options: Some(f.options.clone()),
                    suggested: Some(true),
                    why: Some(f.why.clone()),
                    ..QuestionMeta::default()
                };
                meta.merge(patch(f));
                update_meta(&self.root, &q.item.id, meta)?;
            }
        }
        Ok(())
    }

    /// Called after an answer is saved: asks for follow-ups on it, options
    /// for the next question, and answers later questions now follow from —
    /// all in one request.
    pub async fn after_answer(
        &self,
        question: &GuidedQuestion,
        answer: &str,
    ) -> Result<AfterAnswer, String> {
        let questions = guided_questions(&self.root);
        let depth = self
            .meta()
            .get(&question.item.id)
            .and_then(|m| m.depth)
            .unwrap_or(0);
        let upcoming = self.next_unadvised(question, &questions).cloned();
        let prompt = build_advice_prompt(&AdviceRequest {
            questions: &questions,
            answered: Some((question, answer, depth)),
            upcoming: upcoming.as_ref(),
        });
        let advice = parse_advice(&(self.ask)(prompt, advice_schema()).await?);

        if let Some(upcoming) = &upcoming {
            update_meta(
                &self.root,
                &upcoming.item.id,
                QuestionMeta {
                    options: Some(advice.upcoming.clone()),
                    suggested: Some(true),
                    ..QuestionMeta::default()
                },
            )?;
        }

        // Only for questions still open and asked exactly — a derived answer
        // attached to the wrong question would be worse than none.
        let mut derived = Vec::new();
        for d in &advice.derived {
            let Some(target) = questions.iter().find(|q| {
                !q.answered
                    && q.item.id != question.item.id
                    && (q.item.name == d.question || slugify(&q.item.name) == slugify(&d.question))
            }) else {
                continue;
            };
            update_meta(
                &self.root,
                &target.item.id,
                QuestionMeta {
                    derived: Some(DerivedAnswer {
                        answer: d.answer.clone(),
                        reason: d.reason.clone(),
                    }),
                    ..QuestionMeta::default()
                },
            )?;
            derived.push(target.item.name.clone());
        }

        let added = if depth >= MAX_DEPTH {
            Vec::new()
        } else {
            insert_follow_ups(question, &advice.follow_ups, &questions, Place::After)
        };
        self.record_added(&question.item.file, &added, |_| QuestionMeta {
            parent: Some(question.item.name.clone()),
            depth: Some(depth + 1),
            ..QuestionMeta::default()
        })?;
        Ok(AfterAnswer { added, derived })
    }

    /// Options for one question, when it is shown and nobody has asked yet.
    pub async fn suggest(&self, question: &GuidedQuestion) -> Result<(), String> {
        if self
            .meta()
            .get(&question.item.id)
            .is_some_and(QuestionMeta::is_suggested)
        {
            return Ok(());
        }
        let questions = guided_questions(&self.root);
        let prompt = build_advice_prompt(&AdviceRequest {
            questions: &questions,
            answered: None,
            upcoming: Some(question),
        });
        let advice = parse_advice(&(self.ask)(prompt, advice_schema()).await?);
        update_meta(
            &self.root,
            &question.item.id,
            QuestionMeta {
                options: Some(advice.upcoming),
                suggested: Some(true),
                ..QuestionMeta::default()
            },
        )
    }

    /// Help for a question the developer does not know how to answer: what
    /// it means, examples for this project, and simpler questions to answer
    /// first. The simpler questions go before it, and their answers can
    /// derive it.
    pub async fn coach(&self, question: &GuidedQuestion) -> Result<Coached, String> {
        let questions = guided_questions(&self.root);
        let depth = self
            .meta()
            .get(&question.item.id)
            .and_then(|m| m.depth)
            .unwrap_or(0);
        let prompt = build_coach_prompt(&questions, question);
        let coaching = parse_coaching(&(self.ask)(prompt, coach_schema()).await?);
        update_meta(
            &self.root,
            &question.item.id,
            QuestionMeta {
                explain: Some(coaching.explain.clone()),
                options: (!coaching.examples.is_empty()).then(|| coaching.examples.clone()),
                suggested: Some(true),
                ..QuestionMeta::default()
            },
        )?;
        let probes = insert_follow_ups(question, &coaching.probes, &questions, Place::Before);
        self.record_added(&question.item.file, &probes, |_| QuestionMeta {
            helps: Some(question.item.name.clone()),
            depth: Some(depth + 1),
            ..QuestionMeta::default()
        })?;
        Ok(Coached {
            explain: coaching.explain,
            probes,
        })
    }

    /// Removes a question the advisor added, and what it remembered about it.
    pub fn dismiss(&self, question: &GuidedQuestion) -> bool {
        let removed = remove_question(question);
        if removed {
            let mut meta = self.meta();
            meta.remove(&question.item.id);
            // The question is gone from the file either way; a stale entry
            // for an id nothing has is harmless.
            let _ = save_meta(&self.root, &meta);
        }
        removed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::foundation::{answer_foundation, foundation_dir, scaffold_foundation};
    use std::sync::Mutex;

    fn root() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("temp dir");
        scaffold_foundation(dir.path()).expect("scaffold");
        dir
    }

    fn stack(root: &Path) -> String {
        fs::read_to_string(foundation_dir(root).join("stack.md")).expect("stack.md")
    }

    fn follow(ask: &str) -> FollowUp {
        FollowUp {
            ask: ask.to_owned(),
            why: String::new(),
            options: Vec::new(),
        }
    }

    fn block_on<T>(work: impl Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime")
            .block_on(work)
    }

    /// An `ask` that answers from a script, in order, and records prompts.
    fn scripted(answers: Vec<Value>) -> (Ask, Arc<Mutex<Vec<String>>>) {
        let prompts = Arc::new(Mutex::new(Vec::new()));
        let answers = Arc::new(Mutex::new(answers.into_iter()));
        let seen = Arc::clone(&prompts);
        let ask: Ask = Arc::new(move |prompt, _schema| {
            seen.lock().expect("prompts").push(prompt);
            let next = answers
                .lock()
                .expect("answers")
                .next()
                .unwrap_or_else(|| json!({ "followUps": [], "upcoming": [] }));
            Box::pin(async move { Ok(next) })
        });
        (ask, prompts)
    }

    fn fixed(answer: Value) -> Ask {
        Arc::new(move |_prompt, _schema| {
            let answer = answer.clone();
            Box::pin(async move { Ok(answer) })
        })
    }

    // --- parsing what the model sent ---------------------------------------

    #[test]
    fn keeps_exactly_one_recommendation_whatever_arrived() {
        let none = parse_advice(&json!({
            "followUps": [],
            "upcoming": [{ "label": "a", "detail": "" }, { "label": "b", "detail": "" }],
        }));
        let marks: Vec<bool> = none.upcoming.iter().map(|o| o.recommended).collect();
        assert_eq!(marks, [true, false]);

        let many = parse_advice(&json!({
            "followUps": [],
            "upcoming": [
                { "label": "a", "detail": "", "recommended": false },
                { "label": "b", "detail": "", "recommended": true },
                { "label": "c", "detail": "", "recommended": true },
            ],
        }));
        let marks: Vec<bool> = many.upcoming.iter().map(|o| o.recommended).collect();
        assert_eq!(marks, [false, true, false]);
    }

    #[test]
    fn anything_malformed_is_no_advice_not_an_error() {
        assert_eq!(parse_advice(&Value::Null), Advice::default());
        assert_eq!(parse_advice(&json!("nope")), Advice::default());
        assert_eq!(
            parse_advice(&json!({
                "followUps": [{ "ask": "" }, 7],
                "upcoming": [{ "label": "" }],
                "derived": [{ "question": "x" }],
            })),
            Advice::default()
        );
        assert_eq!(parse_coaching(&json!([1, 2])), Coaching::default());
    }

    #[test]
    fn caps_how_much_a_model_can_add_at_once() {
        let many: Vec<Value> = (0..9)
            .map(|i| json!({ "ask": format!("Q{i}?"), "why": "", "options": [] }))
            .collect();
        let advice = parse_advice(&json!({ "followUps": many, "upcoming": [], "derived": [] }));
        assert_eq!(advice.follow_ups.len(), 3);
    }

    #[test]
    fn a_copied_section_prefix_is_stripped() {
        let advice = parse_advice(&json!({
            "followUps": [{ "ask": "[Stack] Which version?", "why": "", "options": [] }],
        }));
        assert_eq!(advice.follow_ups[0].ask, "Which version?");
    }

    // --- the prompt ---------------------------------------------------------

    #[test]
    fn carries_what_is_decided_what_is_open_and_asks_for_current_versions() {
        let r = root();
        let first = guided_questions(r.path()).remove(0);
        answer_foundation(&first.item, "Python").expect("answer");
        let qs = guided_questions(r.path());
        let prompt = build_advice_prompt(&AdviceRequest {
            questions: &qs,
            answered: Some((&qs[0], "Python", 0)),
            upcoming: Some(&qs[1]),
        });
        assert!(prompt.contains("- [Stack] Language and runtime, with versions.\n  Python"));
        assert!(prompt.contains("Still open (never ask these again):"));
        assert!(prompt.contains("- [Stack] Framework, if any"));
        assert!(prompt.contains("upcoming: options for the next question — [Stack] Framework"));
        assert!(prompt.contains("most recent stable release"));
        assert!(prompt.contains("web search"));
    }

    #[test]
    fn stops_asking_for_follow_ups_at_the_depth_limit() {
        let r = root();
        let qs = guided_questions(r.path());
        let prompt = build_advice_prompt(&AdviceRequest {
            questions: &qs,
            answered: Some((&qs[0], "3.14", MAX_DEPTH)),
            upcoming: None,
        });
        assert!(prompt.contains("followUps: return an empty list"));
    }

    // --- follow-ups in the files --------------------------------------------

    #[test]
    fn are_inserted_straight_after_their_parent_left_tbd() {
        let r = root();
        let lang = guided_questions(r.path()).remove(0);
        answer_foundation(&lang.item, "Python").expect("answer");
        let qs = guided_questions(r.path());
        let added = insert_follow_ups(
            &qs[0],
            &[follow("Which Python version?")],
            &qs,
            Place::After,
        );
        assert_eq!(added.len(), 1);
        assert!(stack(r.path()).contains(
            "## Language and runtime, with versions.\n\nPython\n\n## Which Python version?\n\nTBD\n\n## Framework"
        ));
        assert_eq!(
            guided_questions(r.path())[1].item.name,
            "Which Python version?"
        );
    }

    #[test]
    fn never_duplicate_a_question_that_already_exists() {
        let r = root();
        let qs = guided_questions(r.path());
        let added = insert_follow_ups(
            &qs[0],
            &[
                follow("Package manager, test runner, linter, formatter."),
                follow("Which version?"),
                follow("Which version?"),
            ],
            &qs,
            Place::After,
        );
        let asks: Vec<&str> = added.iter().map(|f| f.ask.as_str()).collect();
        assert_eq!(asks, ["Which version?"]);
    }

    #[test]
    fn can_be_removed_again_leaving_the_rest_intact() {
        let r = root();
        let qs = guided_questions(r.path());
        insert_follow_ups(&qs[0], &[follow("Which version?")], &qs, Place::After);
        let added = guided_questions(r.path())
            .into_iter()
            .find(|q| q.item.name == "Which version?")
            .expect("inserted");
        assert!(remove_question(&added));
        assert!(!stack(r.path()).contains("Which version?"));
        let names = |qs: &[GuidedQuestion]| -> Vec<String> {
            qs.iter().map(|q| q.item.name.clone()).collect()
        };
        assert_eq!(names(&guided_questions(r.path())), names(&qs));
    }

    #[test]
    fn simpler_questions_go_before_the_one_they_help_decide() {
        let r = root();
        let qs = guided_questions(r.path());
        let added = insert_follow_ups(&qs[1], &[follow("Web or CLI?")], &qs, Place::Before);
        assert_eq!(added.len(), 1);
        let names: Vec<String> = guided_questions(r.path())
            .into_iter()
            .map(|q| q.item.name)
            .collect();
        assert_eq!(names[1], "Web or CLI?");
        assert_eq!(names[2], qs[1].item.name);
    }

    // --- the advisor --------------------------------------------------------

    #[test]
    fn after_an_answer_adds_follow_ups_with_their_options_and_advises_the_next_question() {
        let r = root();
        let (ask, _) = scripted(vec![json!({
            "followUps": [{
                "ask": "Which Python version?",
                "why": "CI pins it.",
                "options": [{ "label": "3.14", "detail": "", "recommended": true }],
            }],
            "upcoming": [{ "label": "FastAPI", "detail": "", "recommended": true }],
        })]);
        let advisor = FoundationAdvisor::new(r.path(), ask);
        let lang = guided_questions(r.path()).remove(0);
        answer_foundation(&lang.item, "Python").expect("answer");

        let done = block_on(advisor.after_answer(&lang, "Python")).expect("advice");
        let asks: Vec<&str> = done.added.iter().map(|f| f.ask.as_str()).collect();
        assert_eq!(asks, ["Which Python version?"]);

        let meta = advisor.meta();
        let (_, follow) = meta
            .iter()
            .find(|(id, _)| id.ends_with("#which-python-version"))
            .expect("the follow-up is remembered");
        assert_eq!(follow.parent.as_deref(), Some(lang.item.name.as_str()));
        assert_eq!(follow.why.as_deref(), Some("CI pins it."));
        assert_eq!(follow.depth, Some(1));
        assert_eq!(follow.options.as_ref().expect("options")[0].label, "3.14");
        // The next question — Framework — was advised in the same request.
        let framework = guided_questions(r.path())
            .into_iter()
            .find(|q| q.item.name.starts_with("Framework"))
            .expect("framework");
        assert_eq!(
            meta[&framework.item.id].options.as_ref().expect("options")[0].label,
            "FastAPI"
        );
    }

    #[test]
    fn a_follow_up_of_a_follow_up_of_a_follow_up_is_never_added() {
        let r = root();
        let (ask, _) = scripted(vec![
            json!({ "followUps": [{ "ask": "L1?", "why": "", "options": [] }], "upcoming": [] }),
            json!({ "followUps": [{ "ask": "L2?", "why": "", "options": [] }], "upcoming": [] }),
            json!({ "followUps": [{ "ask": "L3?", "why": "", "options": [] }], "upcoming": [] }),
        ]);
        let advisor = FoundationAdvisor::new(r.path(), ask);
        let find = |name: &str| {
            guided_questions(r.path())
                .into_iter()
                .find(|q| q.item.name == name)
                .expect("question")
        };
        let first = guided_questions(r.path()).remove(0);
        block_on(advisor.after_answer(&first, "Python")).expect("advice");
        block_on(advisor.after_answer(&find("L1?"), "x")).expect("advice");
        let last = block_on(advisor.after_answer(&find("L2?"), "y")).expect("advice");
        assert!(last.added.is_empty());
        assert!(!stack(r.path()).contains("L3?"));
    }

    #[test]
    fn suggest_asks_once_per_question_even_when_nothing_came_back() {
        let r = root();
        let (ask, prompts) = scripted(Vec::new());
        let advisor = FoundationAdvisor::new(r.path(), ask);
        let q = guided_questions(r.path()).remove(0);
        block_on(advisor.suggest(&q)).expect("suggest");
        block_on(advisor.suggest(&q)).expect("suggest");
        assert_eq!(prompts.lock().expect("prompts").len(), 1);
    }

    #[test]
    fn an_answer_that_follows_from_earlier_ones_is_proposed_never_written() {
        let r = root();
        let advisor = FoundationAdvisor::new(
            r.path(),
            fixed(json!({
                "followUps": [],
                "upcoming": [],
                "derived": [
                    {
                        "question": "[Architecture] Where business rules live, and what must never leak into them.",
                        "answer": "In domain/",
                        "reason": "Clean architecture",
                    },
                    { "question": "A question nobody asked", "answer": "x", "reason": "y" },
                ],
            })),
        );
        let arch = guided_questions(r.path())
            .into_iter()
            .find(|q| q.item.name.starts_with("Architecture style"))
            .expect("architecture");
        answer_foundation(&arch.item, "Clean architecture").expect("answer");
        let done = block_on(advisor.after_answer(&arch, "Clean architecture")).expect("advice");

        assert_eq!(
            done.derived,
            ["Where business rules live, and what must never leak into them."]
        );
        let target = guided_questions(r.path())
            .into_iter()
            .find(|q| q.item.name.starts_with("Where business rules"))
            .expect("target");
        assert_eq!(
            advisor.meta()[&target.item.id].derived,
            Some(DerivedAnswer {
                answer: "In domain/".to_owned(),
                reason: "Clean architecture".to_owned(),
            })
        );
        // Proposed only: the file still holds the open question.
        assert!(!target.answered);
    }

    #[test]
    fn help_explains_gives_examples_and_puts_simpler_questions_before_it() {
        let r = root();
        let (ask, prompts) = scripted(vec![json!({
            "explain": "Where your data lives between runs.",
            "examples": [{ "label": "SQLite", "detail": "one file", "recommended": true }],
            "probes": [{ "ask": "Will several people use it at the same time?", "why": "", "options": [] }],
        })]);
        let advisor = FoundationAdvisor::new(r.path(), ask);
        let store = guided_questions(r.path())
            .into_iter()
            .find(|q| q.item.name.starts_with("Datastore"))
            .expect("datastore");
        let coached = block_on(advisor.coach(&store)).expect("coach");

        assert!(prompts.lock().expect("prompts")[0]
            .contains("does not know how to answer — [Stack] Datastore"));
        let asks: Vec<&str> = coached.probes.iter().map(|p| p.ask.as_str()).collect();
        assert_eq!(asks, ["Will several people use it at the same time?"]);
        let names: Vec<String> = guided_questions(r.path())
            .into_iter()
            .map(|q| q.item.name)
            .collect();
        let at = |name: &str| names.iter().position(|n| n == name).expect("present");
        assert_eq!(
            at("Will several people use it at the same time?"),
            at(&store.item.name) - 1
        );

        let meta = advisor.meta();
        let store_meta = &meta[&store.item.id];
        assert_eq!(
            store_meta.explain.as_deref(),
            Some("Where your data lives between runs.")
        );
        assert_eq!(
            store_meta.options.as_ref().expect("options")[0].label,
            "SQLite"
        );
        let probe = guided_questions(r.path())
            .into_iter()
            .find(|q| q.item.name.starts_with("Will several"))
            .expect("probe");
        assert_eq!(
            meta[&probe.item.id].helps.as_deref(),
            Some(store.item.name.as_str())
        );
    }

    #[test]
    fn dismissing_removes_the_question_and_its_memory() {
        let r = root();
        let (ask, _) = scripted(vec![json!({
            "followUps": [{ "ask": "Which version?", "why": "", "options": [] }],
            "upcoming": [],
        })]);
        let advisor = FoundationAdvisor::new(r.path(), ask);
        let first = guided_questions(r.path()).remove(0);
        block_on(advisor.after_answer(&first, "Python")).expect("advice");
        let added = guided_questions(r.path())
            .into_iter()
            .find(|q| q.item.name == "Which version?")
            .expect("added");
        assert!(advisor.meta().contains_key(&added.item.id));
        assert!(advisor.dismiss(&added));
        assert!(!advisor.meta().contains_key(&added.item.id));
        assert!(!stack(r.path()).contains("Which version?"));
    }

    #[test]
    fn a_failing_model_is_an_error_and_writes_nothing() {
        let r = root();
        let ask: Ask = Arc::new(|_, _| Box::pin(async { Err("rate limited".to_owned()) }));
        let advisor = FoundationAdvisor::new(r.path(), ask);
        let first = guided_questions(r.path()).remove(0);
        let before = stack(r.path());
        assert_eq!(
            block_on(advisor.after_answer(&first, "Go")),
            Err("rate limited".to_owned())
        );
        assert_eq!(stack(r.path()), before);
        assert!(advisor.meta().is_empty());
    }

    #[test]
    fn the_sidecar_is_pretty_camel_case_json_and_reads_back() {
        let r = root();
        let mut meta = Meta::new();
        meta.insert(
            "foundation/stack#x".to_owned(),
            QuestionMeta {
                suggested: Some(true),
                derived: Some(DerivedAnswer {
                    answer: "a".to_owned(),
                    reason: "b".to_owned(),
                }),
                ..QuestionMeta::default()
            },
        );
        save_meta(r.path(), &meta).expect("save");
        let raw = fs::read_to_string(meta_path(r.path())).expect("read");
        assert_eq!(
            raw,
            "{\n  \"foundation/stack#x\": {\n    \"suggested\": true,\n    \"derived\": {\n      \"answer\": \"a\",\n      \"reason\": \"b\"\n    }\n  }\n}\n"
        );
        assert_eq!(load_meta(r.path()), meta);
    }
}
