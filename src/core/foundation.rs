//! The Foundation: ground rules decided before the first change.
//!
//! OpenSpec's `init` scaffolds directories and agent instructions. It does not
//! ask what the project *is* — language, framework, architecture style, testing
//! strategy, layering — so the first change's design invents them implicitly
//! and every later change inherits an accident (docs/problem-analysis.md §9).
//!
//! Foundation documents are reviewed through the same accept loop as anything
//! else, and enter every agent's context bundle once accepted.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::markdown::{build_code_fence_mask, normalized_lines, SECTION_HEADER};
use super::requirements::{hash_block, slugify, ReviewItem};

pub fn foundation_dir(project_root: impl AsRef<Path>) -> PathBuf {
    project_root
        .as_ref()
        .join("spec-tacular")
        .join("foundation")
}

/// One ground-rule question, and what a useful answer to it looks like.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FoundationQuestion {
    /// Becomes the section heading, so it is also the question's identity.
    pub ask: &'static str,
    /// Shown while answering, never written to disk. Phrased as examples of
    /// *kinds* of answer so that nobody mistakes one for a recommended default.
    pub hint: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FoundationDoc {
    pub name: &'static str,
    pub title: &'static str,
    /// What this document settles, in one line, for the guided setup.
    pub purpose: &'static str,
    pub questions: &'static [FoundationQuestion],
}

const STACK_QUESTIONS: &[FoundationQuestion] = &[
    FoundationQuestion {
        ask: "Language and runtime, with versions.",
        hint: "e.g. \"TypeScript 5.6 on Bun 1.4\" or \"Python 3.12, CPython\"",
    },
    FoundationQuestion {
        ask: "Framework, if any, and why it over the alternatives.",
        hint: "e.g. \"Hono — small, runs on Bun; Express ruled out for its middleware model\", or \"none\"",
    },
    FoundationQuestion {
        ask: "Datastore and how schema changes are managed.",
        hint: "e.g. \"Postgres 16, migrations via drizzle-kit, never edited by hand\", or \"no persistence\"",
    },
    FoundationQuestion {
        ask: "Package manager, test runner, linter, formatter.",
        hint: "e.g. \"bun, bun test, eslint, prettier\"",
    },
    FoundationQuestion {
        ask: "Anything explicitly ruled out, and why.",
        hint: "e.g. \"no ORM — queries stay visible\", \"no client-side state library\"",
    },
];

const DOMAIN_QUESTIONS: &[FoundationQuestion] = &[
    FoundationQuestion {
        ask: "What the system is for, and who uses it.",
        hint: "Two sentences. e.g. \"Lets clinic staff book rooms. Used by receptionists, not patients.\"",
    },
    FoundationQuestion {
        ask: "The core terms, each with a one-line meaning.",
        hint: "The shared vocabulary. e.g. \"Booking: a room held for a time slot. Slot: 15 minutes, never split.\"",
    },
    FoundationQuestion {
        ask: "Rules about the domain that must always hold.",
        hint: "Invariants. e.g. \"A room is never double-booked. A cancelled booking is kept, not deleted.\"",
    },
    FoundationQuestion {
        ask: "What is explicitly out of scope.",
        hint: "e.g. \"Billing. Patient records. Anything a patient does themselves.\"",
    },
];

const ARCHITECTURE_QUESTIONS: &[FoundationQuestion] = &[
    FoundationQuestion {
        ask: "Architecture style (layered, hexagonal, vertical slice, ...) and why.",
        hint: "e.g. \"Clean architecture: domain in the centre, use cases around it, adapters at the edge\"",
    },
    FoundationQuestion {
        ask: "The layers or modules, and which may depend on which.",
        hint: "e.g. \"domain ← application ← adapters ← main. Inner layers never import outer ones.\"",
    },
    FoundationQuestion {
        ask: "Where business rules live, and what must never leak into them.",
        hint: "e.g. \"In domain/. No HTTP, SQL, framework types or clocks — those are passed in.\"",
    },
    FoundationQuestion {
        ask: "How errors are represented and propagated.",
        hint: "e.g. \"Result types in the domain; exceptions only for bugs; mapped to HTTP at the edge\"",
    },
    FoundationQuestion {
        ask: "How the system is configured and how secrets are handled.",
        hint: "e.g. \"Env vars validated once at startup; secrets never logged or committed\"",
    },
];

const CONVENTIONS_QUESTIONS: &[FoundationQuestion] = &[
    FoundationQuestion {
        ask: "Naming: files, types, functions, tests.",
        hint: "e.g. \"kebab-case files, PascalCase types, verbs for functions, tests named after behaviour\"",
    },
    FoundationQuestion {
        ask: "What a test must cover before a change is considered done.",
        hint: "e.g. \"Every requirement's scenarios as tests; no mocks of our own code\"",
    },
    FoundationQuestion {
        ask: "How code is reviewed and what blocks a merge.",
        hint: "e.g. \"One approval; failing typecheck or tests block; style never blocks\"",
    },
    FoundationQuestion {
        ask: "Comment style: what is worth writing down and what is noise.",
        hint: "e.g. \"Explain why, never what; link the requirement a non-obvious rule comes from\"",
    },
    FoundationQuestion {
        ask: "Anything a new contributor reliably gets wrong.",
        hint: "e.g. \"Timezones: store UTC, convert only for display\"",
    },
];

/// The documents `spectacular init` scaffolds, and what each must answer.
///
/// Ordered as the guided setup asks them: what it is built with, what it is
/// about, how it is shaped, and how the team works on it.
pub const FOUNDATION_DOCS: &[FoundationDoc] = &[
    FoundationDoc {
        name: "stack.md",
        title: "Stack",
        purpose: "What the project is built with.",
        questions: STACK_QUESTIONS,
    },
    FoundationDoc {
        name: "domain.md",
        title: "Domain",
        purpose: "What the project is about, in its own words.",
        questions: DOMAIN_QUESTIONS,
    },
    FoundationDoc {
        name: "architecture.md",
        title: "Architecture",
        purpose: "How the code is shaped, and which way dependencies point.",
        questions: ARCHITECTURE_QUESTIONS,
    },
    FoundationDoc {
        name: "conventions.md",
        title: "Conventions",
        purpose: "How the team works on it day to day.",
        questions: CONVENTIONS_QUESTIONS,
    },
];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScaffoldResult {
    pub created: Vec<String>,
    pub skipped: Vec<String>,
}

/// Writes the Foundation scaffold.
///
/// Every question is left visibly unanswered rather than pre-filled with a
/// plausible default. A default nobody chose is indistinguishable from a
/// decision, which is precisely the failure this phase exists to prevent.
pub fn scaffold_foundation(project_root: impl AsRef<Path>) -> io::Result<ScaffoldResult> {
    let dir = foundation_dir(project_root);
    fs::create_dir_all(&dir)?;

    let mut result = ScaffoldResult::default();
    for doc in FOUNDATION_DOCS {
        let file = dir.join(doc.name);
        if file.exists() {
            // Never overwrite: these hold decisions a human made.
            result.skipped.push(doc.name.to_owned());
            continue;
        }
        let mut body = format!("# {}\n\n", doc.title);
        for q in doc.questions {
            body.push_str(&format!("## {}\n\nTBD\n\n", q.ask));
        }
        // The TypeScript joined the lines, leaving no trailing newline after
        // the final blank one; reproduced so the scaffold is byte-identical.
        let body = body.trim_end_matches('\n').to_owned() + "\n";
        fs::write(&file, body)?;
        result.created.push(doc.name.to_owned());
    }
    Ok(result)
}

/// A Foundation section, reviewable one at a time like any other item.
pub fn parse_foundation_doc(content: &str, file: &str, name: &str) -> Vec<ReviewItem> {
    let lines = normalized_lines(content);
    let mask = build_code_fence_mask(&lines);
    let group = format!("foundation/{}", name.strip_suffix(".md").unwrap_or(name));

    let mut items: Vec<ReviewItem> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();

    let mut i = 0;
    while i < lines.len() {
        let line = &lines[i];
        if mask[i] || !SECTION_HEADER.is_match(line) {
            i += 1;
            continue;
        }

        let title = SECTION_HEADER.replace(line, "").trim().to_owned();
        let mut body_lines: Vec<&str> = Vec::new();
        let mut j = i + 1;
        while j < lines.len() {
            if !mask[j] && SECTION_HEADER.is_match(&lines[j]) {
                break;
            }
            body_lines.push(&lines[j]);
            j += 1;
        }

        let base = slugify(&title);
        let count = seen.entry(base.clone()).or_insert(0);
        *count += 1;
        let slug = if *count == 1 {
            base
        } else {
            format!("{base}~{count}")
        };

        let mut block = line.clone();
        for body_line in &body_lines {
            block.push('\n');
            block.push_str(body_line);
        }

        items.push(ReviewItem {
            id: format!("{group}#{slug}"),
            capability: group.clone(),
            name: title,
            text: body_lines.join("\n").trim().to_owned(),
            file: file.to_owned(),
            line: i + 1,
            hash: hash_block(&block),
            spec: None,
        });

        i = j;
    }

    items
}

/// Every Foundation section across every document, in a stable order.
pub fn load_foundation(project_root: impl AsRef<Path>) -> Vec<ReviewItem> {
    let dir = foundation_dir(project_root);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".md"))
        .collect();
    names.sort();

    let mut items = Vec::new();
    for name in names {
        let file = dir.join(&name);
        // An unreadable document is better skipped than fatal — the rest of
        // the Foundation is still worth reviewing.
        if let Ok(content) = fs::read_to_string(&file) {
            items.extend(parse_foundation_doc(
                &content,
                &file.to_string_lossy(),
                &name,
            ));
        }
    }
    items
}

/// A section still holding the scaffold's placeholder.
pub fn is_unanswered(item: &ReviewItem) -> bool {
    let text = item.text.trim();
    text.is_empty() || text.eq_ignore_ascii_case("TBD")
}

pub fn foundation_exists(project_root: impl AsRef<Path>) -> bool {
    // Existence, not directory-ness: a `foundation` that is somehow a file is
    // a broken project, and the gate has a better message for "no sections"
    // than this has for "wrong kind of thing".
    foundation_dir(project_root).exists()
}

/// A Foundation section as the guided setup asks it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuidedQuestion {
    pub item: ReviewItem,
    /// The document it belongs to, e.g. `Architecture`.
    pub title: String,
    pub purpose: String,
    /// Empty for a section a human added that the scaffold never asked.
    pub hint: String,
    pub answered: bool,
}

/// Every Foundation section in the order the guided setup asks them.
///
/// The files are the source of truth, not [`FOUNDATION_DOCS`]: a question a
/// human deleted is not asked again, and one they added is asked too — after
/// the scaffold's own, since nothing says where it belongs.
pub fn guided_questions(project_root: impl AsRef<Path>) -> Vec<GuidedQuestion> {
    let items = load_foundation(project_root);

    let ask = |name: &str, title: &str, purpose: &str, questions: &[FoundationQuestion]| {
        let group = format!("foundation/{}", name.strip_suffix(".md").unwrap_or(name));
        items
            .iter()
            .filter(|item| item.capability == group)
            .map(|item| GuidedQuestion {
                hint: questions
                    .iter()
                    .find(|q| q.ask == item.name)
                    .map_or(String::new(), |q| q.hint.to_owned()),
                answered: !is_unanswered(item),
                item: item.clone(),
                title: title.to_owned(),
                purpose: purpose.to_owned(),
            })
            .collect::<Vec<_>>()
    };

    let mut out: Vec<GuidedQuestion> = FOUNDATION_DOCS
        .iter()
        .flat_map(|doc| ask(doc.name, doc.title, doc.purpose, doc.questions))
        .collect();

    // Anything a human added, asked after the scaffold's own questions: nothing
    // in the file says where it belongs, and guessing would reorder their work.
    let known: BTreeSet<&str> = FOUNDATION_DOCS.iter().map(|d| d.name).collect();
    let extra: BTreeSet<String> = items
        .iter()
        .map(|i| file_name_of(&i.file))
        .filter(|name| !known.contains(name.as_str()))
        .collect();
    for name in extra {
        let title = name.strip_suffix(".md").unwrap_or(&name).to_owned();
        out.extend(ask(&name, &title, "", &[]));
    }

    out
}

fn file_name_of(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_owned()
}

/// Writes an answer into its section, replacing whatever the section held.
///
/// Located by heading rather than trusted by line number alone: the file may
/// have been edited since it was parsed, and writing an answer under the wrong
/// question is worse than refusing.
pub fn answer_foundation(item: &ReviewItem, answer: &str) -> Result<(), String> {
    let text = answer.trim();
    if text.is_empty() {
        return Err("An empty answer would leave the question open".to_owned());
    }

    let content = fs::read_to_string(&item.file)
        .map_err(|err| format!("Could not read {}: {err}", item.file))?;

    let lines = normalized_lines(&content);
    let mask = build_code_fence_mask(&lines);
    let is_heading = |i: usize| {
        !mask[i]
            && SECTION_HEADER.is_match(&lines[i])
            && SECTION_HEADER.replace(&lines[i], "").trim() == item.name
    };

    let hinted = item.line.checked_sub(1).unwrap_or(usize::MAX);
    let start = if hinted < lines.len() && is_heading(hinted) {
        hinted
    } else {
        match (0..lines.len()).find(|i| is_heading(*i)) {
            Some(at) => at,
            None => return Err(format!("\"{}\" is no longer in {}", item.name, item.file)),
        }
    };

    let mut end = start + 1;
    while end < lines.len() && (mask[end] || !SECTION_HEADER.is_match(&lines[end])) {
        end += 1;
    }

    let mut next: Vec<&str> = lines[..=start].iter().map(String::as_str).collect();
    next.push("");
    next.push(text);
    next.push("");
    next.extend(lines[end..].iter().map(String::as_str));
    fs::write(&item.file, next.join("\n"))
        .map_err(|err| format!("Could not write {}: {err}", item.file))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> tempfile::TempDir {
        tempfile::tempdir().expect("a temp dir")
    }

    fn read(path: PathBuf) -> String {
        fs::read_to_string(path).expect("the file reads")
    }

    #[test]
    fn writes_a_document_per_area_with_every_question_unanswered() {
        // A default nobody chose is indistinguishable from a decision, which is
        // the failure this phase exists to prevent.
        let r = root();
        let result = scaffold_foundation(r.path()).expect("the scaffold writes");
        assert_eq!(
            result.created,
            FOUNDATION_DOCS.iter().map(|d| d.name).collect::<Vec<_>>()
        );

        let stack = read(foundation_dir(r.path()).join("stack.md"));
        assert!(stack.contains("# Stack"));
        assert!(stack.contains("## Language and runtime, with versions."));
        assert!(stack.contains("TBD"));
    }

    #[test]
    fn never_overwrites_answers_that_already_exist() {
        let r = root();
        scaffold_foundation(r.path()).expect("the scaffold writes");
        fs::write(
            foundation_dir(r.path()).join("stack.md"),
            "# Stack\n\n## Language\n\nTypeScript.\n",
        )
        .expect("the file writes");

        let again = scaffold_foundation(r.path()).expect("the scaffold runs again");
        assert!(again.created.is_empty());
        assert!(again.skipped.contains(&"stack.md".to_owned()));
        assert!(read(foundation_dir(r.path()).join("stack.md")).contains("TypeScript."));
    }

    #[test]
    fn each_section_is_a_reviewable_item() {
        let items = parse_foundation_doc(
            "# Stack\n\n## Language\n\nTypeScript.\n\n## Datastore\n\nPostgres.\n",
            "/p/spec-tacular/foundation/stack.md",
            "stack.md",
        );
        let got: Vec<_> = items
            .iter()
            .map(|i| (i.id.as_str(), i.name.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![
                ("foundation/stack#language", "Language"),
                ("foundation/stack#datastore", "Datastore"),
            ]
        );
        assert_eq!(items[0].text, "TypeScript.");
        assert!(items[0].hash.starts_with("sha256:"));
    }

    #[test]
    fn loads_every_document_in_a_stable_order() {
        let r = root();
        scaffold_foundation(r.path()).expect("the scaffold writes");
        let mut groups: Vec<String> = Vec::new();
        for item in load_foundation(r.path()) {
            if !groups.contains(&item.capability) {
                groups.push(item.capability);
            }
        }
        assert_eq!(
            groups,
            vec![
                "foundation/architecture",
                "foundation/conventions",
                "foundation/domain",
                "foundation/stack",
            ]
        );
    }

    #[test]
    fn an_absent_foundation_is_empty_not_an_error() {
        assert!(load_foundation(root().path()).is_empty());
    }

    #[test]
    fn recognises_an_unanswered_question() {
        let items = parse_foundation_doc(
            "# Stack\n\n## A\n\nTBD\n\n## B\n\nBun.\n",
            "/p/f/stack.md",
            "stack.md",
        );
        assert!(is_unanswered(&items[0]));
        assert!(!is_unanswered(&items[1]));
    }

    #[test]
    fn guided_questions_are_asked_stack_domain_architecture_conventions_with_hints() {
        let r = root();
        scaffold_foundation(r.path()).expect("the scaffold writes");
        let qs = guided_questions(r.path());

        let mut titles: Vec<&str> = Vec::new();
        for q in &qs {
            if !titles.contains(&q.title.as_str()) {
                titles.push(&q.title);
            }
        }
        assert_eq!(
            titles,
            vec!["Stack", "Domain", "Architecture", "Conventions"]
        );
        assert!(qs.iter().all(|q| !q.hint.is_empty() && !q.answered));
        assert!(qs
            .iter()
            .find(|q| q.title == "Architecture")
            .expect("an architecture question")
            .hint
            .contains("Clean architecture"));
    }

    #[test]
    fn an_answer_replaces_the_placeholder_and_nothing_else() {
        let r = root();
        scaffold_foundation(r.path()).expect("the scaffold writes");
        let qs = guided_questions(r.path());
        assert_eq!(
            answer_foundation(&qs[0].item, "TypeScript 5.6 on Bun 1.4"),
            Ok(())
        );

        let file = read(foundation_dir(r.path()).join("stack.md"));
        assert!(file.contains(
            "## Language and runtime, with versions.\n\nTypeScript 5.6 on Bun 1.4\n\n## Framework"
        ));
        let after = guided_questions(r.path());
        assert!(after[0].answered);
        assert_eq!(after[1].item.name, qs[1].item.name);
        assert!(!after[1].answered);
    }

    #[test]
    fn re_answering_replaces_the_previous_answer() {
        let r = root();
        scaffold_foundation(r.path()).expect("the scaffold writes");
        answer_foundation(&guided_questions(r.path())[0].item, "Python")
            .expect("the answer writes");
        answer_foundation(&guided_questions(r.path())[0].item, "Go 1.23")
            .expect("the answer writes");
        let file = read(foundation_dir(r.path()).join("stack.md"));
        assert!(file.contains("Go 1.23"));
        assert!(!file.contains("Python"));
    }

    #[test]
    fn an_empty_answer_is_refused_rather_than_silently_leaving_it_open() {
        let r = root();
        scaffold_foundation(r.path()).expect("the scaffold writes");
        assert!(answer_foundation(&guided_questions(r.path())[0].item, "  ").is_err());
    }

    #[test]
    fn a_question_removed_from_the_file_since_it_was_read_is_refused() {
        let r = root();
        scaffold_foundation(r.path()).expect("the scaffold writes");
        let q = guided_questions(r.path()).remove(0);
        fs::write(&q.item.file, "# Stack\n\n## Something else\n\nTBD\n").expect("the file writes");
        assert!(answer_foundation(&q.item, "Bun").is_err());
    }

    #[test]
    fn a_missing_file_is_reported_rather_than_panicking() {
        let item = ReviewItem {
            file: "/nope/stack.md".to_owned(),
            ..parse_foundation_doc("# S\n\n## A\n\nTBD\n", "/nope/stack.md", "stack.md")[0].clone()
        };
        assert!(answer_foundation(&item, "Bun").is_err());
    }

    #[test]
    fn a_section_a_human_added_is_asked_too_after_the_scaffolds_own() {
        let r = root();
        scaffold_foundation(r.path()).expect("the scaffold writes");
        fs::write(
            foundation_dir(r.path()).join("security.md"),
            "# Security\n\n## Threat model\n\nTBD\n",
        )
        .expect("the file writes");
        let qs = guided_questions(r.path());
        let last = qs.last().expect("at least one question");
        assert_eq!(last.item.name, "Threat model");
        assert_eq!(last.hint, "");
    }
}
