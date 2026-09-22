//! The shape of `openspec ... --json` output that spec-tacular relies on.
//!
//! These mirror OpenSpec's published CLI contract, not its internal modules —
//! the CLI's JSON surface is the more stable of the two. Fields spec-tacular
//! does not use are deliberately omitted; deserialization ignores extras so an
//! upstream addition is never a breaking change.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// OpenSpec's per-artifact state. Derived purely from file existence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OpenSpecArtifactStatus {
    Done,
    Ready,
    Blocked,
    /// A state this version of spec-tacular does not know.
    ///
    /// TypeScript declared the three names as a type and never checked them at
    /// runtime, so an OpenSpec that grows a fourth simply read as "not done".
    /// A closed enum would instead fail the whole status parse, which is the
    /// one thing the module promises never to do.
    #[default]
    Unknown,
}

impl<'de> Deserialize<'de> for OpenSpecArtifactStatus {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Ok(match raw.as_str() {
            "done" => Self::Done,
            "ready" => Self::Ready,
            "blocked" => Self::Blocked,
            _ => Self::Unknown,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSpecArtifact {
    pub id: String,
    #[serde(default)]
    pub output_path: String,
    #[serde(default)]
    pub status: OpenSpecArtifactStatus,
    #[serde(default)]
    pub requires: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSpecArtifactPaths {
    #[serde(default)]
    pub output_path: String,
    #[serde(default)]
    pub resolved_output_path: String,
    #[serde(default)]
    pub existing_output_paths: Vec<String>,
}

/// Every field defaults: TypeScript declared them as required but never
/// checked, so a partial object from an older or newer OpenSpec has to read
/// rather than fail the whole status.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OpenSpecPlanningHome {
    pub kind: String,
    pub root: String,
    pub changes_dir: String,
    pub default_schema: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSpecChangeStatus {
    pub change_name: String,
    #[serde(default)]
    pub schema_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning_home: Option<OpenSpecPlanningHome>,
    #[serde(default)]
    pub change_root: String,
    #[serde(default)]
    pub artifact_paths: BTreeMap<String, OpenSpecArtifactPaths>,
    #[serde(default)]
    pub is_planning_complete: bool,
    #[serde(default)]
    pub apply_requires: Vec<String>,
    #[serde(default)]
    pub next_steps: Vec<String>,
    /// Absent on a change that failed to load — see [`ChangeEntry`].
    #[serde(default)]
    pub artifacts: Vec<OpenSpecArtifact>,
}

/// `openspec status --all --json`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct OpenSpecBatchStatus {
    #[serde(default)]
    pub changes: Vec<ChangeEntry>,
    #[serde(default)]
    pub root: Option<OpenSpecRoot>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct OpenSpecRoot {
    pub path: String,
}

/// A change that failed to load. OpenSpec's batch sweep does not abort on one
/// bad change — it emits a diagnostic entry in place of a status — so the
/// adapter must expect entries that carry no `artifacts`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSpecChangeError {
    pub change_name: String,
}

/// One entry of a batch sweep: either a status, or a diagnostic standing in
/// for one.
///
/// TypeScript told the two apart with a type guard on `artifacts`; serde needs
/// the same rule stated once, in [`ChangeEntry::classify`], because an untagged
/// enum would happily read a broken entry as a status with no artifacts.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ChangeEntry {
    #[serde(rename = "changeName", default)]
    pub change_name: String,
    /// Kept as raw JSON, because the rule that tells a status from a
    /// diagnostic is "is this an array?" — and a typed field would turn
    /// `"artifacts": "oops"` into a parse failure for the whole sweep instead
    /// of one bad entry.
    #[serde(default)]
    pub artifacts: Option<serde_json::Value>,
    /// Everything else, kept so a well-formed entry can be re-read as a
    /// status without a second request.
    #[serde(flatten)]
    pub rest: serde_json::Value,
}

/// A batch entry, told apart the way the TypeScript `isChangeError` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangeOrError {
    Change(Box<OpenSpecChangeStatus>),
    Error(OpenSpecChangeError),
}

impl ChangeEntry {
    /// Whether this entry is a diagnostic rather than a status.
    ///
    /// The rule is OpenSpec's: no `artifacts` array means the change did not
    /// load. Anything else — including one with an empty array — is a status.
    pub fn is_change_error(&self) -> bool {
        !self
            .artifacts
            .as_ref()
            .is_some_and(serde_json::Value::is_array)
    }

    /// Reads the entry as whichever of the two it is.
    ///
    /// A status that fails to deserialize is reported as an error entry rather
    /// than aborting the sweep: one malformed change must not hide the rest.
    pub fn classify(self) -> ChangeOrError {
        if self.is_change_error() {
            return ChangeOrError::Error(OpenSpecChangeError {
                change_name: self.change_name,
            });
        }
        let change_name = self.change_name.clone();
        match self.into_status() {
            Some(status) => ChangeOrError::Change(Box::new(status)),
            None => ChangeOrError::Error(OpenSpecChangeError { change_name }),
        }
    }

    fn into_status(self) -> Option<OpenSpecChangeStatus> {
        let mut value = self.rest;
        let object = value.as_object_mut()?;
        object.insert(
            "changeName".to_owned(),
            serde_json::Value::String(self.change_name),
        );
        object.insert("artifacts".to_owned(), self.artifacts?);
        serde_json::from_value(value).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_status_without_artifacts_is_an_error_entry() {
        let entry: ChangeEntry =
            serde_json::from_str(r#"{"changeName":"broken","status":"unreadable"}"#)
                .expect("the entry parses");
        assert!(entry.is_change_error());
        assert_eq!(
            entry.classify(),
            ChangeOrError::Error(OpenSpecChangeError {
                change_name: "broken".to_owned()
            })
        );
    }

    #[test]
    fn an_artifacts_key_that_is_not_an_array_is_an_error_entry() {
        // The rule is `Array.isArray`, not "the key is present". A typed field
        // would instead fail the whole sweep, so one broken change would hide
        // every other one.
        for raw in [
            r#"{"changeName":"broken","artifacts":"oops"}"#,
            r#"{"changeName":"broken","artifacts":{}}"#,
            r#"{"changeName":"broken","artifacts":null}"#,
        ] {
            let entry: ChangeEntry = serde_json::from_str(raw).expect("the entry parses");
            assert!(entry.is_change_error(), "{raw}");
        }
    }

    #[test]
    fn an_artifact_state_this_version_does_not_know_still_parses() {
        // An upstream addition must never be a breaking change: a fourth
        // status reads as "not done", exactly as the untyped TypeScript did.
        let artifact: OpenSpecArtifact =
            serde_json::from_str(r#"{"id":"specs","status":"skipped"}"#).expect("parses");
        assert_eq!(artifact.status, OpenSpecArtifactStatus::Unknown);
        assert_ne!(artifact.status, OpenSpecArtifactStatus::Done);
    }

    #[test]
    fn a_partial_planning_home_reads_rather_than_failing_the_status() {
        let status: OpenSpecChangeStatus =
            serde_json::from_str(r#"{"changeName":"c","planningHome":{"kind":"repo"}}"#)
                .expect("parses");
        let home = status.planning_home.expect("a planning home");
        assert_eq!(home.kind, "repo");
        assert_eq!(home.root, "");
    }

    #[test]
    fn a_status_with_artifacts_reads_as_a_change() {
        let entry: ChangeEntry = serde_json::from_str(
            r#"{"changeName":"c","schemaName":"spec-driven","changeRoot":"/tmp/c",
                "applyRequires":["tasks"],
                "artifacts":[{"id":"proposal","outputPath":"proposal.md","status":"done","requires":[]}]}"#,
        )
        .expect("the entry parses");
        assert!(!entry.is_change_error());
        match entry.classify() {
            ChangeOrError::Change(status) => {
                assert_eq!(status.change_name, "c");
                assert_eq!(status.schema_name, "spec-driven");
                assert_eq!(status.apply_requires, vec!["tasks"]);
                assert_eq!(status.artifacts.len(), 1);
                assert_eq!(status.artifacts[0].id, "proposal");
            }
            ChangeOrError::Error(e) => {
                panic!("expected a change, got an error for {}", e.change_name)
            }
        }
    }

    #[test]
    fn an_empty_artifacts_array_is_a_change_not_an_error() {
        let entry: ChangeEntry =
            serde_json::from_str(r#"{"changeName":"c","artifacts":[]}"#).expect("the entry parses");
        assert!(!entry.is_change_error());
    }

    #[test]
    fn unknown_fields_are_ignored_so_an_upstream_addition_never_breaks_us() {
        let status: OpenSpecChangeStatus = serde_json::from_str(
            r#"{"changeName":"c","brandNewField":42,
                "artifacts":[{"id":"specs","outputPath":"specs/","status":"ready","requires":[],"extra":true}]}"#,
        )
        .expect("the status parses");
        assert_eq!(status.change_name, "c");
        assert_eq!(status.artifacts[0].status, OpenSpecArtifactStatus::Ready);
    }

    #[test]
    fn a_batch_sweep_carries_both_kinds_of_entry() {
        let batch: OpenSpecBatchStatus = serde_json::from_str(
            r#"{"root":{"path":"/p"},"changes":[
                {"changeName":"ok","artifacts":[]},
                {"changeName":"broken"}
            ]}"#,
        )
        .expect("the batch parses");
        assert_eq!(batch.root.map(|r| r.path).as_deref(), Some("/p"));
        assert_eq!(
            batch
                .changes
                .iter()
                .map(ChangeEntry::is_change_error)
                .collect::<Vec<_>>(),
            vec![false, true]
        );
    }
}
