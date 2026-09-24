//! Installs spec-tacular's schema into an OpenSpec project.
//!
//! The schema is what enforces `proposal → specs → design → tasks` for anyone
//! running plain `openspec`, without spec-tacular in the loop
//! (docs/problem-analysis.md §1). Its one substantive change from `spec-driven`
//! is `design.requires: [specs]` instead of `[proposal]`; the rest is
//! instruction wording for abstraction, example marking and deferral.
//!
//! The schema is compiled into the binary rather than read from beside it.
//! A single static file people download is the point of the port, and a tool
//! that installs a schema it can only find in its own source tree is not one
//! file. [`BUNDLED_SCHEMA`] is the whole of it, and the copy on disk under
//! `schemas/` is what those `include_str!`s read, so the two cannot drift.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use regex::{NoExpand, Regex};

use super::foundation::scaffold_foundation;

pub const SCHEMA_NAME: &str = "spec-tacular";

const SCHEMA_ROOT: &str = "schemas/spec-tacular";

/// The bundled schema: each file's path relative to the schema directory,
/// with its contents. Sorted, because [`InitResult::files`] is.
pub const BUNDLED_SCHEMA: &[(&str, &str)] = &[
    (
        "schema.yaml",
        include_str!("../../schemas/spec-tacular/schema.yaml"),
    ),
    (
        "templates/design.md",
        include_str!("../../schemas/spec-tacular/templates/design.md"),
    ),
    (
        "templates/proposal.md",
        include_str!("../../schemas/spec-tacular/templates/proposal.md"),
    ),
    (
        "templates/spec.md",
        include_str!("../../schemas/spec-tacular/templates/spec.md"),
    ),
    (
        "templates/tasks.md",
        include_str!("../../schemas/spec-tacular/templates/tasks.md"),
    ),
];

/// Where the bundled schema lives in *this repository*.
///
/// The TypeScript `bundledSchemaDir()` was the directory the schema was copied
/// from at runtime; here nothing reads it at runtime, so it is only ever the
/// answer to "which files does [`BUNDLED_SCHEMA`] mirror" — for the test that
/// pins them byte for byte.
pub fn bundled_schema_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(SCHEMA_ROOT)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitResult {
    pub schema_dir: PathBuf,
    /// The installed files, relative to `schema_dir`, in sorted order.
    pub files: Vec<String>,
    /// True when an existing install was replaced.
    pub replaced: bool,
    pub config_updated: bool,
    /// Foundation documents written, and those left alone because they existed.
    pub foundation_created: Vec<String>,
    pub foundation_skipped: Vec<String>,
    pub notes: Vec<String>,
}

/// The project's OpenSpec config, whether or not it exists yet.
pub fn config_path(project_root: impl AsRef<Path>) -> PathBuf {
    project_root.as_ref().join("openspec").join("config.yaml")
}

/// Where a schema is installed in a project.
pub fn schema_dir(project_root: impl AsRef<Path>, schema: &str) -> PathBuf {
    project_root
        .as_ref()
        .join("openspec")
        .join("schemas")
        .join(schema)
}

/// Points the project's config at a schema.
///
/// Rewrites only the `schema:` line, leaving `context:`, `rules:` and any
/// comments untouched — this file is hand-maintained and holds a project's
/// house rules, so replacing it wholesale would destroy real work.
///
/// Returns whether anything was written.
pub fn set_project_schema(project_root: impl AsRef<Path>, schema: &str) -> io::Result<bool> {
    let config = config_path(project_root);

    let Ok(original) = fs::read_to_string(&config) else {
        // Unreadable counts as absent, exactly as `existsSync` did: the file
        // this is about to write is the one that matters.
        if let Some(parent) = config.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&config, format!("schema: {schema}\n"))?;
        return Ok(true);
    };

    // Only a top-level `schema:` key — one nested under `rules:` or quoted
    // inside `context:` must not be touched.
    let line = Regex::new(r"(?m)^schema:[ \t]*\S.*$").expect("built-in pattern");
    if line.is_match(&original) {
        let updated = line.replacen(&original, 1, NoExpand(&format!("schema: {schema}")));
        if updated == original {
            return Ok(false);
        }
        fs::write(&config, updated.as_ref())?;
        return Ok(true);
    }
    fs::write(&config, format!("schema: {schema}\n{original}"))?;
    Ok(true)
}

/// Installs the schema, scaffolds the Foundation, and points the config at it.
///
/// `set_schema` is the TypeScript `options.setSchema`; passing `false` installs
/// the files without changing which schema new changes use.
pub fn init_project(project_root: impl AsRef<Path>, set_schema: bool) -> io::Result<InitResult> {
    let project_root = project_root.as_ref();
    let schema_dir = schema_dir(project_root, SCHEMA_NAME);
    let replaced = schema_dir.exists();

    let mut files: Vec<String> = Vec::with_capacity(BUNDLED_SCHEMA.len());
    for (relative, contents) in BUNDLED_SCHEMA {
        let target = relative
            .split('/')
            .fold(schema_dir.clone(), |path, part| path.join(part));
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&target, contents)?;
        files.push((*relative).to_owned());
    }
    files.sort();

    let mut notes: Vec<String> = Vec::new();
    if replaced {
        notes.push(format!(
            "Replaced the existing {SCHEMA_NAME} schema. Local edits to it are gone; \
             fork it under another name to keep your own."
        ));
    }

    let foundation = scaffold_foundation(project_root)?;
    if !foundation.created.is_empty() {
        notes.push(
            "Answer the Foundation questions before proposing a change. Every one is \
             left as TBD on purpose: a default nobody chose is indistinguishable \
             from a decision."
                .to_owned(),
        );
    }

    let config_updated = if set_schema {
        set_project_schema(project_root, SCHEMA_NAME)?
    } else {
        false
    };
    if config_updated {
        // Existing changes pin their schema in their own .openspec.yaml, so this
        // affects new changes only. Saying so avoids the assumption that it
        // retroactively re-sequences work already in flight.
        notes.push(
            "New changes will use this schema. Changes already in flight keep theirs.".to_owned(),
        );
    }

    Ok(InitResult {
        schema_dir,
        files,
        replaced,
        config_updated,
        foundation_created: foundation.created,
        foundation_skipped: foundation.skipped,
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn project() -> TempDir {
        let dir = TempDir::new().expect("temp dir");
        fs::create_dir_all(dir.path().join("openspec")).expect("openspec dir");
        dir
    }

    fn config_of(root: &Path) -> String {
        fs::read_to_string(config_path(root)).expect("config.yaml")
    }

    #[test]
    fn installs_the_schema_and_its_templates() {
        let dir = project();
        let result = init_project(dir.path(), true).expect("init");

        assert_eq!(
            result.schema_dir,
            dir.path().join("openspec/schemas/spec-tacular")
        );
        assert_eq!(
            result.files,
            vec![
                "schema.yaml",
                "templates/design.md",
                "templates/proposal.md",
                "templates/spec.md",
                "templates/tasks.md",
            ]
        );
        assert!(result.schema_dir.join("schema.yaml").is_file());
    }

    #[test]
    fn the_installed_schema_sequences_design_after_specs() {
        // The whole reason the schema exists (problem-analysis §1).
        let dir = project();
        let installed = init_project(dir.path(), true).expect("init").schema_dir;
        let yaml = fs::read_to_string(installed.join("schema.yaml")).expect("schema.yaml");
        let design = &yaml[yaml.find("- id: design").expect("a design artifact")..];
        let design = &design[..design.find("- id: tasks").expect("a tasks artifact")];
        assert!(design.contains("- specs"), "design must require specs");
    }

    #[test]
    fn what_is_installed_is_byte_for_byte_what_the_repository_ships() {
        // The binary carries the schema so it needs no files beside it; that is
        // only safe while the embedded copy and the one under `schemas/` are
        // the same bytes.
        let dir = project();
        let installed = init_project(dir.path(), true).expect("init").schema_dir;
        for (relative, _) in BUNDLED_SCHEMA {
            let on_disk = fs::read(installed.join(relative)).expect("installed file");
            let source = fs::read(bundled_schema_dir().join(relative)).expect("source file");
            assert_eq!(on_disk, source, "{relative} differs from schemas/");
        }
    }

    #[test]
    fn points_the_project_config_at_the_schema() {
        let dir = project();
        let result = init_project(dir.path(), true).expect("init");
        assert!(result.config_updated);
        assert!(config_of(dir.path()).contains(&format!("schema: {SCHEMA_NAME}")));
    }

    #[test]
    fn reports_a_replacement_so_local_edits_are_not_lost_silently() {
        let dir = project();
        assert!(!init_project(dir.path(), true).expect("init").replaced);
        let again = init_project(dir.path(), true).expect("init");
        assert!(again.replaced);
        assert!(again.notes.join(" ").contains("Local edits"));
    }

    #[test]
    fn says_the_schema_applies_to_new_changes_only() {
        // Existing changes pin their schema in their own .openspec.yaml.
        let dir = project();
        let notes = init_project(dir.path(), true)
            .expect("init")
            .notes
            .join(" ");
        assert!(notes.contains("already in flight keep theirs"));
    }

    #[test]
    fn set_schema_false_leaves_the_config_alone() {
        let dir = project();
        fs::write(config_path(dir.path()), "schema: spec-driven\n").expect("write config");
        assert!(
            !init_project(dir.path(), false)
                .expect("init")
                .config_updated
        );
        assert!(config_of(dir.path()).contains("schema: spec-driven"));
    }

    #[test]
    fn creates_a_config_when_none_exists() {
        let dir = project();
        assert!(set_project_schema(dir.path(), "x").expect("set"));
        assert_eq!(config_of(dir.path()), "schema: x\n");
    }

    #[test]
    fn rewrites_only_the_schema_line_preserving_context_and_rules() {
        // config.yaml is hand-maintained and holds a project's house rules;
        // replacing it wholesale would destroy real work.
        let dir = project();
        let original = "schema: spec-driven\n\ncontext: |\n  Tech stack: TypeScript\n\nrules:\n  specs:\n    - Prefer observable behaviour\n";
        fs::write(config_path(dir.path()), original).expect("write config");

        set_project_schema(dir.path(), SCHEMA_NAME).expect("set");
        let updated = config_of(dir.path());
        assert!(updated.contains(&format!("schema: {SCHEMA_NAME}")));
        assert!(!updated.contains("spec-driven"));
        assert!(updated.contains("Tech stack: TypeScript"));
        assert!(updated.contains("- Prefer observable behaviour"));
    }

    #[test]
    fn prepends_a_schema_key_when_the_config_has_none() {
        let dir = project();
        fs::write(config_path(dir.path()), "context: |\n  Something\n").expect("write config");
        set_project_schema(dir.path(), "x").expect("set");
        assert_eq!(
            config_of(dir.path()),
            "schema: x\ncontext: |\n  Something\n"
        );
    }

    #[test]
    fn does_not_touch_a_nested_schema_key() {
        let dir = project();
        fs::write(
            config_path(dir.path()),
            "context: |\n  schema: not-the-real-one\nschema: spec-driven\n",
        )
        .expect("write config");
        set_project_schema(dir.path(), "x").expect("set");
        let updated = config_of(dir.path());
        assert!(updated.contains("  schema: not-the-real-one"));
        assert!(updated.contains("\nschema: x\n"));
    }

    #[test]
    fn is_a_no_op_when_already_set() {
        let dir = project();
        fs::write(config_path(dir.path()), "schema: x\n").expect("write config");
        assert!(!set_project_schema(dir.path(), "x").expect("set"));
    }

    #[test]
    fn a_replacement_value_is_never_read_as_a_capture_group() {
        // `$1` in a schema name would be expanded by a naive replace.
        let dir = project();
        fs::write(config_path(dir.path()), "schema: old\n").expect("write config");
        set_project_schema(dir.path(), "weird$1name").expect("set");
        assert_eq!(config_of(dir.path()), "schema: weird$1name\n");
    }

    #[test]
    fn scaffolds_the_foundation_alongside_the_schema() {
        let dir = project();
        let result = init_project(dir.path(), true).expect("init");
        assert!(result.foundation_created.contains(&"stack.md".to_owned()));
        assert!(result.foundation_skipped.is_empty());
        let again = init_project(dir.path(), true).expect("init");
        assert!(again.foundation_created.is_empty());
        assert!(again.foundation_skipped.contains(&"stack.md".to_owned()));
    }
}
