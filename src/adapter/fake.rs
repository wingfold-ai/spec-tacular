//! A stand-in `openspec`, for tests that need a subprocess but not the real
//! CLI.
//!
//! What is under test where this is used is how spec-tacular *treats* the
//! command it runs — its JSON, its exit code, its stderr, its silence — and a
//! shell script states that far more directly than a mocked module boundary
//! would. The real CLI is therefore not a test dependency; `tests/cli.rs` has
//! the one smoke test that uses it when it happens to be installed.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use super::openspec::OpenSpecAdapter;

/// The one executable stand-in, written once per test process and shared by
/// every test in it.
///
/// A script per test would be simpler, but writing an executable while another
/// thread sits between `fork` and `exec` makes that exec fail with ETXTBSY — a
/// real race, and one this suite reproduced within a handful of runs. So
/// exactly one file is ever executed, it is written before any test spawns
/// anything, and what it *does* is read from `fake-openspec.sh` in the working
/// directory, which is plain data and can be rewritten freely.
pub fn dispatcher() -> &'static Path {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/test-fakes");
        fs::create_dir_all(&dir).expect("the fake's directory");
        let path = dir.join(format!("openspec-{}", std::process::id()));
        fs::write(&path, "#!/bin/sh\nexec /bin/sh ./fake-openspec.sh \"$@\"\n")
            .expect("write the dispatcher");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("chmod");
        path
    })
}

/// What the stand-in does inside `project`: a shell script the dispatcher runs
/// with the arguments it was given.
pub fn script(project: &Path, body: &str) -> PathBuf {
    fs::write(
        project.join("fake-openspec.sh"),
        format!("#!/bin/sh\n{body}\n"),
    )
    .expect("write the fake");
    dispatcher().to_path_buf()
}

/// An adapter for `project`, answered by `body`.
pub fn adapter(project: &Path, body: &str) -> OpenSpecAdapter {
    OpenSpecAdapter::new(project, Some(script(project, body)))
}
