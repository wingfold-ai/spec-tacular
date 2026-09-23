//! Opening a file in the developer's editor, at a line.
//!
//! The TypeScript `editor.ts`. The terminal must be handed over first — the
//! editor takes it, and two programs drawing to one screen produces garbage
//! that survives the editor exiting — which is the event loop's half of the
//! job (`terminal::Tui::suspend`). This half decides *which* editor, and how
//! to tell it the line.

use std::path::Path;
use std::process::Command;

/// `+12 file` is understood by vim, nvim, nano, emacs and helix alike; the
/// VS Code family wants `--goto file:12`.
pub fn args_for(editor: &str, file: &Path, line: usize) -> Vec<String> {
    let mut words = editor.split_whitespace();
    let program = words.next().unwrap_or_default();
    let mut args: Vec<String> = words.map(str::to_owned).collect();
    let name = program.rsplit('/').next().unwrap_or(program);
    if matches!(name, "code" | "codium" | "subl") {
        args.push("--goto".to_owned());
        args.push(format!("{}:{line}", file.display()));
    } else {
        args.push(format!("+{line}"));
        args.push(file.display().to_string());
    }
    args
}

/// `$VISUAL`, then `$EDITOR`, then the first common terminal editor installed.
///
/// The fallback matters on a first run: plenty of machines never set
/// `$EDITOR`, and "No $EDITOR set" is a dead end for someone being guided.
/// Takes the environment as a lookup so it is testable without mutating the
/// process's own.
pub fn resolve_editor(env: impl Fn(&str) -> Option<String>) -> Option<String> {
    let chosen = env("VISUAL")
        .filter(|v| !v.is_empty())
        .or_else(|| env("EDITOR").filter(|v| !v.is_empty()));
    if chosen.is_some() {
        return chosen;
    }
    let path = env("PATH").unwrap_or_default();
    ["nano", "vim", "vi"]
        .into_iter()
        .find(|name| {
            std::env::split_paths(&path)
                .filter(|dir| !dir.as_os_str().is_empty())
                .any(|dir| dir.join(name).exists())
        })
        .map(str::to_owned)
}

/// Runs the editor on `file` and waits for it. The caller has already
/// suspended the TUI and restores it afterwards whatever this returns.
pub fn open_in_editor(file: &Path, line: usize) -> Result<(), String> {
    let Some(editor) = resolve_editor(|name| std::env::var(name).ok()) else {
        return Err("No $EDITOR set, and no nano or vim found".to_owned());
    };
    let program = editor.split_whitespace().next().unwrap_or_default();
    match Command::new(program)
        .args(args_for(&editor, file, line))
        .status()
    {
        Ok(_) => Ok(()),
        Err(error) => Err(format!("Could not run {program}: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn the_editor_falls_back_when_editor_is_unset() {
        assert_eq!(
            resolve_editor(env(&[("EDITOR", "hx")])).as_deref(),
            Some("hx")
        );
        assert_eq!(
            resolve_editor(env(&[("VISUAL", "code -w"), ("EDITOR", "hx")])).as_deref(),
            Some("code -w")
        );
        assert_eq!(resolve_editor(env(&[("PATH", "")])), None);
    }

    #[test]
    fn the_first_installed_terminal_editor_is_found_on_path() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        std::fs::write(dir.path().join("vim"), "").expect("vim");
        let path = dir.path().display().to_string();
        assert_eq!(
            resolve_editor(env(&[("PATH", &path)])).as_deref(),
            Some("vim")
        );
    }

    #[test]
    fn the_line_is_passed_the_way_each_editor_understands_it() {
        let file = Path::new("/p/spec.md");
        assert_eq!(args_for("vim", file, 12), ["+12", "/p/spec.md"]);
        assert_eq!(
            args_for("/usr/bin/code -w", file, 3),
            ["-w", "--goto", "/p/spec.md:3"]
        );
    }
}
