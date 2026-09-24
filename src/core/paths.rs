//! Paths as they are written down.
//!
//! `Path::join` in Rust keeps every component it is given, so a project opened
//! with `--cwd .` produces `./spec-tacular/roadmap.yaml`. Node's `path.join`
//! normalizes the `.` away, so the TypeScript implementation printed — and
//! recorded — `spec-tacular/roadmap.yaml` for the same project.
//!
//! That difference is not cosmetic in both directions. In a message it is only
//! noise, but a job record carries its log path across to the other
//! implementation, and two spellings of one file are two files to anything
//! that compares them as strings.
//!
//! So every path that becomes text goes through here, whether it is printed or
//! stored.

use std::path::{Component, Path, PathBuf};

/// A path as a string, with `.` components normalized away.
///
/// Only `.` is removed. `..` is left exactly where it is: resolving it
/// textually is wrong the moment a symlink is involved, and unlike Node this
/// code never builds a path that contains one.
pub fn display_path(path: impl AsRef<Path>) -> String {
    let path = path.as_ref();

    // `components()` already drops `.` everywhere but the front, where it
    // keeps it so that a relative path cannot turn into an absolute one.
    let mut out = PathBuf::new();
    let mut components = path.components().peekable();
    if matches!(components.peek(), Some(Component::CurDir)) {
        components.next();
    }
    out.extend(components);

    // `.` and `./` normalize to nothing, and an empty string names no file.
    if out.as_os_str().is_empty() {
        return ".".to_owned();
    }
    out.display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_leading_dot_is_dropped() {
        assert_eq!(
            display_path("./spec-tacular/roadmap.yaml"),
            "spec-tacular/roadmap.yaml"
        );
        assert_eq!(
            display_path(Path::new(".").join("openspec/specs")),
            "openspec/specs"
        );
    }

    #[test]
    fn an_interior_dot_is_collapsed() {
        assert_eq!(display_path("a/./b/./c"), "a/b/c");
        assert_eq!(display_path("a//b"), "a/b");
    }

    #[test]
    fn a_path_that_is_only_a_dot_stays_one() {
        // It names the working directory, and the empty string names nothing.
        assert_eq!(display_path("."), ".");
        assert_eq!(display_path("./"), ".");
        assert_eq!(display_path(""), ".");
    }

    #[test]
    fn an_absolute_path_is_untouched() {
        assert_eq!(display_path("/tmp/p/spec.md"), "/tmp/p/spec.md");
        assert_eq!(display_path("/"), "/");
    }

    #[test]
    fn a_parent_component_is_left_where_it_is() {
        // Node's `join` would resolve these; doing it textually is wrong as
        // soon as a symlink is in the way, and nothing here produces one.
        assert_eq!(display_path("../p/spec.md"), "../p/spec.md");
        assert_eq!(display_path("./../p"), "../p");
    }

    #[test]
    fn it_agrees_with_node_on_the_paths_this_program_builds() {
        // Captured from `node -e "console.log(path.join(...))"` — the shapes
        // every command actually prints, for a project opened as `.`, as a
        // relative directory, and as an absolute one.
        for (built, node) in [
            (
                Path::new(".").join("spec-tacular/pending-validation.md"),
                "spec-tacular/pending-validation.md",
            ),
            (
                Path::new(".").join(".spec-tacular/jobs"),
                ".spec-tacular/jobs",
            ),
            (
                Path::new("work").join("openspec/specs/cap/spec.md"),
                "work/openspec/specs/cap/spec.md",
            ),
            (
                Path::new("/p").join("spec-tacular/roadmap.yaml"),
                "/p/spec-tacular/roadmap.yaml",
            ),
        ] {
            assert_eq!(display_path(&built), node, "built from {built:?}");
        }
    }
}
