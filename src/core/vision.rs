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
//! The interview itself lands in stage 8. What is here is the part
//! [`crate::core::guide::project_stage`] needs to tell a new project from one
//! with a baseline: whether the project starts from nothing, and whether the
//! developer has already said it does not.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// A saved interview, as much of it as stage 5 reads.
///
/// Unknown fields are ignored rather than rejected: a session written by a
/// later stage — or by the TypeScript implementation — must still answer
/// "did they skip it?" here.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct VisionSession {
    /// The developer's own description, as typed.
    #[serde(default)]
    pub vision: String,
    /// The model has enough, or the developer ended the interview.
    #[serde(default)]
    pub finished: bool,
    /// Not a new project after all — start from a single change instead.
    #[serde(default)]
    pub skipped: bool,
}

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

/// Where a half-finished interview is kept, so it can be left and resumed.
pub fn session_path(project_root: impl AsRef<Path>) -> PathBuf {
    project_root
        .as_ref()
        .join(".spec-tacular")
        .join("vision-session.json")
}

/// The saved interview, or `None` when there is none or it will not parse.
///
/// A corrupt session is treated as no session: this only decides which screen
/// opens, and refusing to start over a malformed scratch file would be worse
/// than starting again.
pub fn load_session(project_root: impl AsRef<Path>) -> Option<VisionSession> {
    let raw = fs::read_to_string(session_path(project_root)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Records "this is not a new project" — the way out of the vision step.
///
/// Its caller is the vision screen's "not a new project", in stage 8; until
/// then only the tests of [`crate::core::guide::project_stage`] use it.
#[allow(dead_code)]
pub fn skip_session(project_root: impl AsRef<Path>) -> io::Result<()> {
    let path = session_path(project_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // The shape the TypeScript `VisionInterviewer.skip` wrote, so a project
    // skipped in one implementation reads as skipped in the other.
    let session = serde_json::json!({
        "vision": "",
        "turns": [],
        "understood": "",
        "pending": null,
        "finished": true,
        "slices": [],
        "skipped": true,
    });
    fs::write(
        &path,
        format!("{}\n", serde_json::to_string_pretty(&session)?),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

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
    fn a_corrupt_session_reads_as_none_rather_than_failing() {
        let dir = TempDir::new().expect("temp dir");
        fs::create_dir_all(dir.path().join(".spec-tacular")).expect("dir");
        fs::write(session_path(dir.path()), "{ not json").expect("write");
        assert!(load_session(dir.path()).is_none());
    }
}
