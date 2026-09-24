//! The roadmap: a vision decomposed into an ordered list of slices.
//!
//! OpenSpec's model is a *change* against an existing baseline — its README
//! says so. On day one there is no baseline, so a vision decomposes into a
//! dozen parallel changes with no sequencing, and every one needs full review
//! before any code exists (docs/problem-analysis.md §4).
//!
//! The roadmap is reviewed first, cheaply: one line per slice. Changes then
//! open one slice at a time, so the review queue never exceeds one change.
//!
//! The file is YAML at `spec-tacular/roadmap.yaml`, with the TypeScript
//! implementation's key names and block layout, so a roadmap written by either
//! implementation loads in the other.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Where a slice is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SliceStatus {
    Planned,
    Active,
    Done,
}

impl SliceStatus {
    /// The word as it is written in the file.
    pub fn as_str(self) -> &'static str {
        match self {
            SliceStatus::Planned => "planned",
            SliceStatus::Active => "active",
            SliceStatus::Done => "done",
        }
    }

    /// The mark the roadmap listing puts in front of a slice.
    pub fn mark(self) -> char {
        match self {
            SliceStatus::Planned => '○',
            SliceStatus::Active => '◉',
            SliceStatus::Done => '✓',
        }
    }
}

/// One shippable step towards the vision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Slice {
    pub id: String,
    pub summary: String,
    pub status: SliceStatus,
    /// Slice ids that must be done first.
    #[serde(rename = "dependsOn")]
    pub depends_on: Vec<String>,
}

/// The vision, and the slices it decomposes into.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Roadmap {
    pub vision: String,
    pub slices: Vec<Slice>,
}

/// `<project>/spec-tacular/roadmap.yaml`.
pub fn roadmap_path(project_root: impl AsRef<Path>) -> PathBuf {
    project_root
        .as_ref()
        .join("spec-tacular")
        .join("roadmap.yaml")
}

/// Whether the project has a roadmap yet.
pub fn roadmap_exists(project_root: impl AsRef<Path>) -> bool {
    roadmap_path(project_root).exists()
}

/// Reads the roadmap.
///
/// `None` covers both "there is none" and "it does not parse": a broken
/// roadmap must not stop the rest of the tool working, and the command that
/// asks for one says which of the two it is by looking at the path.
pub fn load_roadmap(project_root: impl AsRef<Path>) -> Option<Roadmap> {
    let content = std::fs::read_to_string(roadmap_path(project_root)).ok()?;
    parse_roadmap(&content)
}

/// The roadmap in `content`, read leniently.
///
/// Every field is optional and every unknown value degrades rather than
/// failing: a slice with no id is dropped (it names nothing that could be
/// promoted) and an unrecognised status reads as `planned`, because the safe
/// reading is that a slice has not started, never that it is finished.
fn parse_roadmap(content: &str) -> Option<Roadmap> {
    let raw: serde_yml::Value = serde_yml::from_str(content).ok()?;
    if raw.is_null() {
        return Some(Roadmap {
            vision: String::new(),
            slices: Vec::new(),
        });
    }

    let vision = raw
        .get("vision")
        .and_then(serde_yml::Value::as_str)
        .unwrap_or_default()
        .to_owned();

    let slices = raw
        .get("slices")
        .and_then(serde_yml::Value::as_sequence)
        .map(|items| items.iter().filter_map(to_slice).collect())
        .unwrap_or_default();

    Some(Roadmap { vision, slices })
}

fn to_slice(raw: &serde_yml::Value) -> Option<Slice> {
    let id = raw.get("id").and_then(serde_yml::Value::as_str)?.trim();
    if id.is_empty() {
        return None;
    }

    let status = match raw
        .get("status")
        .and_then(serde_yml::Value::as_str)
        .unwrap_or_default()
        .trim()
    {
        "active" => SliceStatus::Active,
        "done" => SliceStatus::Done,
        _ => SliceStatus::Planned,
    };

    Some(Slice {
        id: id.to_owned(),
        summary: raw
            .get("summary")
            .and_then(serde_yml::Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_owned(),
        status,
        depends_on: raw
            .get("dependsOn")
            .and_then(serde_yml::Value::as_sequence)
            .map(|items| {
                items
                    .iter()
                    .filter_map(serde_yml::Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// Writes the roadmap.
pub fn save_roadmap(project_root: impl AsRef<Path>, roadmap: &Roadmap) -> io::Result<()> {
    let path = roadmap_path(project_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, render_roadmap(roadmap))
}

/// The roadmap as YAML, in the layout the TypeScript `yaml` package writes.
///
/// Emitted by hand rather than by a serializer because the two implementations
/// share this file, and every YAML writer indents block sequences differently
/// — valid either way, but a diff on every save from whichever tool touched it
/// last is not something a repository should have to carry. Each *scalar* is
/// still quoted by the YAML library, so the one part where getting it wrong
/// would corrupt data is not hand-rolled.
fn render_roadmap(roadmap: &Roadmap) -> String {
    let mut out = format!("vision: {}\n", scalar(&roadmap.vision));
    if roadmap.slices.is_empty() {
        out.push_str("slices: []\n");
        return out;
    }

    out.push_str("slices:\n");
    for slice in &roadmap.slices {
        out.push_str(&format!("  - id: {}\n", scalar(&slice.id)));
        out.push_str(&format!("    summary: {}\n", scalar(&slice.summary)));
        out.push_str(&format!("    status: {}\n", slice.status.as_str()));
        if slice.depends_on.is_empty() {
            out.push_str("    dependsOn: []\n");
        } else {
            out.push_str("    dependsOn:\n");
            for dep in &slice.depends_on {
                out.push_str(&format!("      - {}\n", scalar(dep)));
            }
        }
    }
    out
}

/// One string as a YAML scalar on a single line.
///
/// `serde_yml` decides the quoting, which is the part that has to be right;
/// what is stripped afterwards is only the document framing it adds.
fn scalar(value: &str) -> String {
    match serde_yml::to_string(&value.to_owned()) {
        Ok(emitted) => emitted
            .trim_start_matches("---")
            .trim_end_matches('\n')
            .trim()
            .to_owned(),
        // Unreachable for a string, and a roadmap is not worth a panic: the
        // double-quoted form is always valid YAML.
        Err(_) => format!("{value:?}"),
    }
}

/// What `spectacular roadmap` scaffolds on a project that has none.
pub fn roadmap_template() -> Roadmap {
    Roadmap {
        vision: "TBD — one paragraph on what this project is for.".to_owned(),
        slices: vec![Slice {
            id: "first-slice".to_owned(),
            summary: "TBD — one line on what a user can do once this lands.".to_owned(),
            status: SliceStatus::Planned,
            depends_on: Vec::new(),
        }],
    }
}

/// Writes the template, unless there is already a roadmap. Returns whether it
/// wrote one.
pub fn scaffold_roadmap(project_root: impl AsRef<Path>) -> io::Result<bool> {
    let project_root = project_root.as_ref();
    if roadmap_exists(project_root) {
        return Ok(false);
    }
    save_roadmap(project_root, &roadmap_template())?;
    Ok(true)
}

/// A promote or complete that went through, or why it did not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SliceChange {
    Changed { slice: Slice, roadmap: Roadmap },
    Refused { reason: String },
}

/// Marks a slice active, so a change can be opened for it.
///
/// One active slice at a time. That single rule is what stops a greenfield
/// project turning into a dozen changes nobody can review: the queue is bounded
/// by construction rather than by discipline.
pub fn promote_slice(roadmap: &Roadmap, id: &str) -> SliceChange {
    let refuse = |reason: String| SliceChange::Refused { reason };

    let Some(slice) = roadmap.slices.iter().find(|s| s.id == id) else {
        return refuse(format!("no slice called '{id}'"));
    };
    match slice.status {
        SliceStatus::Done => return refuse(format!("'{id}' is already done")),
        SliceStatus::Active => return refuse(format!("'{id}' is already active")),
        SliceStatus::Planned => {}
    }

    if let Some(active) = roadmap
        .slices
        .iter()
        .find(|s| s.status == SliceStatus::Active)
    {
        return refuse(format!(
            "'{}' is already active. Finish or park it first — one slice at a \
             time is what keeps the review queue to a single change.",
            active.id
        ));
    }

    // A dependency that does not exist is a broken roadmap, and treating it as
    // satisfied would let the slice through on a typo.
    let blocking: Vec<&str> = slice
        .depends_on
        .iter()
        .filter(|dep| {
            !roadmap
                .slices
                .iter()
                .any(|s| &&s.id == dep && s.status == SliceStatus::Done)
        })
        .map(String::as_str)
        .collect();
    if !blocking.is_empty() {
        return refuse(format!(
            "'{id}' depends on {}, not done yet",
            blocking.join(", ")
        ));
    }

    SliceChange::Changed {
        slice: Slice {
            status: SliceStatus::Active,
            ..slice.clone()
        },
        roadmap: with_status(roadmap, id, SliceStatus::Active),
    }
}

/// Marks a slice done, freeing the next one to be promoted.
pub fn complete_slice(roadmap: &Roadmap, id: &str) -> SliceChange {
    let Some(slice) = roadmap.slices.iter().find(|s| s.id == id) else {
        return SliceChange::Refused {
            reason: format!("no slice called '{id}'"),
        };
    };
    SliceChange::Changed {
        slice: Slice {
            status: SliceStatus::Done,
            ..slice.clone()
        },
        roadmap: with_status(roadmap, id, SliceStatus::Done),
    }
}

fn with_status(roadmap: &Roadmap, id: &str, status: SliceStatus) -> Roadmap {
    Roadmap {
        vision: roadmap.vision.clone(),
        slices: roadmap
            .slices
            .iter()
            .map(|s| {
                if s.id == id {
                    Slice {
                        status,
                        ..s.clone()
                    }
                } else {
                    s.clone()
                }
            })
            .collect(),
    }
}

/// The next slice that could be promoted, or `None` when none can be.
pub fn next_promotable(roadmap: &Roadmap) -> Option<&Slice> {
    if roadmap
        .slices
        .iter()
        .any(|s| s.status == SliceStatus::Active)
    {
        return None;
    }
    roadmap.slices.iter().find(|s| {
        s.status == SliceStatus::Planned
            && s.depends_on.iter().all(|dep| {
                roadmap
                    .slices
                    .iter()
                    .find(|o| &o.id == dep)
                    .is_some_and(|o| o.status == SliceStatus::Done)
            })
    })
}

/// The active slice, if one is.
pub fn active_slice(roadmap: &Roadmap) -> Option<&Slice> {
    roadmap
        .slices
        .iter()
        .find(|s| s.status == SliceStatus::Active)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Exactly what the TypeScript `saveRoadmap` writes for the roadmap below,
    /// captured by running it under bun.
    ///
    /// The two implementations share this file — a project set up with one is
    /// opened with the other — so the bytes are pinned rather than described.
    const TS_WRITTEN: &str = "vision: A tool for reviewing specs.\n\
slices:\n\
\x20 - id: auth\n\
\x20   summary: Users can sign in\n\
\x20   status: planned\n\
\x20   dependsOn: []\n\
\x20 - id: export\n\
\x20   summary: Users can export\n\
\x20   status: planned\n\
\x20   dependsOn:\n\
\x20     - auth\n\
\x20 - id: billing\n\
\x20   summary: Users can pay\n\
\x20   status: planned\n\
\x20   dependsOn: []\n";

    /// And what it writes for the scaffolded template.
    const TS_TEMPLATE: &str = "vision: TBD — one paragraph on what this project is for.\n\
slices:\n\
\x20 - id: first-slice\n\
\x20   summary: TBD — one line on what a user can do once this lands.\n\
\x20   status: planned\n\
\x20   dependsOn: []\n";

    fn roadmap() -> Roadmap {
        Roadmap {
            vision: "A tool for reviewing specs.".to_owned(),
            slices: vec![
                Slice {
                    id: "auth".to_owned(),
                    summary: "Users can sign in".to_owned(),
                    status: SliceStatus::Planned,
                    depends_on: Vec::new(),
                },
                Slice {
                    id: "export".to_owned(),
                    summary: "Users can export".to_owned(),
                    status: SliceStatus::Planned,
                    depends_on: vec!["auth".to_owned()],
                },
                Slice {
                    id: "billing".to_owned(),
                    summary: "Users can pay".to_owned(),
                    status: SliceStatus::Planned,
                    depends_on: Vec::new(),
                },
            ],
        }
    }

    fn write(dir: &TempDir, content: &str) {
        std::fs::create_dir_all(dir.path().join("spec-tacular")).expect("dir");
        std::fs::write(roadmap_path(dir.path()), content).expect("write");
    }

    #[test]
    fn round_trips() {
        let dir = TempDir::new().expect("temp dir");
        save_roadmap(dir.path(), &roadmap()).expect("save");
        assert_eq!(load_roadmap(dir.path()), Some(roadmap()));
    }

    #[test]
    fn writes_what_the_typescript_implementation_writes() {
        let dir = TempDir::new().expect("temp dir");
        save_roadmap(dir.path(), &roadmap()).expect("save");
        assert_eq!(
            std::fs::read_to_string(roadmap_path(dir.path())).expect("read"),
            TS_WRITTEN
        );
        let scaffolded = TempDir::new().expect("temp dir");
        save_roadmap(scaffolded.path(), &roadmap_template()).expect("save");
        assert_eq!(
            std::fs::read_to_string(roadmap_path(scaffolded.path())).expect("read"),
            TS_TEMPLATE
        );
    }

    #[test]
    fn reads_what_the_typescript_implementation_wrote() {
        let dir = TempDir::new().expect("temp dir");
        write(&dir, TS_WRITTEN);
        assert_eq!(load_roadmap(dir.path()), Some(roadmap()));
    }

    #[test]
    fn a_value_that_needs_quoting_stays_one_value() {
        // A summary is free text, and `key: value` inside it would otherwise
        // turn one slice into a mapping nobody wrote.
        let tricky = Roadmap {
            vision: "yes".to_owned(),
            slices: vec![Slice {
                id: "1.0".to_owned(),
                summary: "Users: can export #now".to_owned(),
                status: SliceStatus::Active,
                depends_on: vec!["- odd".to_owned()],
            }],
        };
        let dir = TempDir::new().expect("temp dir");
        save_roadmap(dir.path(), &tricky).expect("save");
        assert_eq!(load_roadmap(dir.path()), Some(tricky));
    }

    #[test]
    fn scaffolds_once_and_never_overwrites() {
        let dir = TempDir::new().expect("temp dir");
        assert!(scaffold_roadmap(dir.path()).expect("scaffold"));
        assert!(load_roadmap(dir.path())
            .expect("loaded")
            .vision
            .contains("TBD"));

        save_roadmap(dir.path(), &roadmap()).expect("save");
        assert!(!scaffold_roadmap(dir.path()).expect("scaffold again"));
        assert_eq!(
            load_roadmap(dir.path()).expect("loaded").vision,
            "A tool for reviewing specs."
        );
    }

    #[test]
    fn an_absent_roadmap_is_none_not_an_error() {
        let dir = TempDir::new().expect("temp dir");
        assert_eq!(load_roadmap(dir.path()), None);
    }

    #[test]
    fn broken_yaml_degrades_rather_than_throwing() {
        let dir = TempDir::new().expect("temp dir");
        write(&dir, "vision: [unclosed\n");
        assert_eq!(load_roadmap(dir.path()), None);
    }

    #[test]
    fn a_slice_with_no_id_is_dropped_and_an_unknown_status_reads_as_planned() {
        // The safe reading is that a slice has not started, never that it is
        // done.
        let dir = TempDir::new().expect("temp dir");
        write(
            &dir,
            "vision: v\nslices:\n  - summary: nameless\n  - id: ok\n    status: nonsense\n",
        );
        let loaded = load_roadmap(dir.path()).expect("loaded");
        assert_eq!(
            loaded
                .slices
                .iter()
                .map(|s| s.id.as_str())
                .collect::<Vec<_>>(),
            ["ok"]
        );
        assert_eq!(loaded.slices[0].status, SliceStatus::Planned);
    }

    #[test]
    fn an_empty_document_is_an_empty_roadmap() {
        let dir = TempDir::new().expect("temp dir");
        write(&dir, "");
        assert_eq!(
            load_roadmap(dir.path()),
            Some(Roadmap {
                vision: String::new(),
                slices: Vec::new()
            })
        );
    }

    #[test]
    fn promoting_makes_a_slice_active() {
        match promote_slice(&roadmap(), "auth") {
            SliceChange::Changed { roadmap, .. } => {
                assert_eq!(roadmap.slices[0].status, SliceStatus::Active)
            }
            other => panic!("expected a promotion, got {other:?}"),
        }
    }

    #[test]
    fn only_one_slice_may_be_active_at_a_time() {
        // The single rule that stops a greenfield project becoming a dozen
        // changes nobody can review.
        let SliceChange::Changed { roadmap, .. } = promote_slice(&roadmap(), "auth") else {
            panic!("auth should promote");
        };
        match promote_slice(&roadmap, "billing") {
            SliceChange::Refused { reason } => {
                assert!(reason.contains("already active"), "{reason}");
                assert!(reason.contains("one slice at a time"), "{reason}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn refuses_while_a_dependency_is_unfinished() {
        match promote_slice(&roadmap(), "export") {
            SliceChange::Refused { reason } => assert!(reason.contains("depends on auth")),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn allows_once_the_dependency_is_done() {
        let SliceChange::Changed { roadmap, .. } = complete_slice(&roadmap(), "auth") else {
            panic!("auth should complete");
        };
        assert!(matches!(
            promote_slice(&roadmap, "export"),
            SliceChange::Changed { .. }
        ));
    }

    #[test]
    fn a_dependency_that_does_not_exist_blocks_rather_than_passing_on_a_typo() {
        let broken = Roadmap {
            vision: String::new(),
            slices: vec![Slice {
                id: "a".to_owned(),
                summary: String::new(),
                status: SliceStatus::Planned,
                depends_on: vec!["typo".to_owned()],
            }],
        };
        assert!(matches!(
            promote_slice(&broken, "a"),
            SliceChange::Refused { .. }
        ));
    }

    #[test]
    fn refuses_an_unknown_or_finished_slice() {
        assert!(matches!(
            promote_slice(&roadmap(), "nope"),
            SliceChange::Refused { .. }
        ));
        let SliceChange::Changed { roadmap, .. } = complete_slice(&roadmap(), "auth") else {
            panic!("auth should complete");
        };
        match promote_slice(&roadmap, "auth") {
            SliceChange::Refused { reason } => assert!(reason.contains("already done")),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn completing_an_unknown_slice_is_refused() {
        assert!(matches!(
            complete_slice(&roadmap(), "nope"),
            SliceChange::Refused { .. }
        ));
    }

    #[test]
    fn next_promotable_is_the_first_unblocked_planned_slice() {
        assert_eq!(
            next_promotable(&roadmap()).map(|s| s.id.as_str()),
            Some("auth")
        );
    }

    #[test]
    fn next_promotable_is_nothing_while_a_slice_is_active() {
        let SliceChange::Changed { roadmap, .. } = promote_slice(&roadmap(), "auth") else {
            panic!("auth should promote");
        };
        assert_eq!(next_promotable(&roadmap), None);
        assert_eq!(active_slice(&roadmap).map(|s| s.id.as_str()), Some("auth"));
    }

    #[test]
    fn next_promotable_skips_a_slice_whose_dependency_is_unfinished() {
        let only = Roadmap {
            vision: String::new(),
            slices: vec![
                Slice {
                    id: "a".to_owned(),
                    summary: String::new(),
                    status: SliceStatus::Done,
                    depends_on: Vec::new(),
                },
                Slice {
                    id: "b".to_owned(),
                    summary: String::new(),
                    status: SliceStatus::Planned,
                    depends_on: vec!["c".to_owned()],
                },
                Slice {
                    id: "c".to_owned(),
                    summary: String::new(),
                    status: SliceStatus::Done,
                    depends_on: Vec::new(),
                },
            ],
        };
        assert_eq!(next_promotable(&only).map(|s| s.id.as_str()), Some("b"));
    }

    #[test]
    fn next_promotable_is_none_when_everything_is_done() {
        let mut current = roadmap();
        for id in ["auth", "export", "billing"] {
            if let SliceChange::Changed { roadmap, .. } = complete_slice(&current, id) {
                current = roadmap;
            }
        }
        assert_eq!(next_promotable(&current), None);
    }
}
