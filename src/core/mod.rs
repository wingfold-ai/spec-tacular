//! The model: everything spec-tacular knows, derived and decided without a
//! terminal and without a subprocess.
//!
//! The rule this directory exists to enforce (docs/architecture.md): `core/`
//! has no terminal code and no subprocess code. It takes plain data in and
//! returns plain data out, so the review loop, the gate and the pipeline are
//! tested directly rather than through a UI, and `--print` and the TUI are two
//! renderings of one model rather than two implementations of one feature.
//!
//! Nothing here knows OpenSpec exists either; that is `adapter/`'s job alone.

// The port lands bottom-up, so parts of the model are complete and tested
// before the screen or the command that first calls them exists — `dead_code`
// reports that as unused. The allow is per module and comes off as each one's
// caller lands: `pipeline`, `context` and `markdown` no longer carry it,
// because stage 3 wired them in.
#[allow(dead_code)]
pub mod advisor;
pub mod archive;
#[allow(dead_code)]
pub mod change_review;
/// The cross-implementation compatibility suite. Tests only: it proves the
/// parser, the hasher and the sidecar writer agree with the TypeScript
/// original, which is what lets a repository be opened by either.
#[cfg(test)]
mod compat;
#[allow(dead_code)]
pub mod concreteness;
pub mod context;
#[allow(dead_code)]
pub mod decisions;
#[allow(dead_code)]
pub mod examples;
#[allow(dead_code)]
pub mod foundation;
#[allow(dead_code)]
pub mod gate;
pub mod guide;
#[allow(dead_code)]
pub mod init;
pub mod jobs;
#[allow(dead_code)]
pub mod mark;
pub mod markdown;
pub mod naming;
pub mod pending;
pub mod pipeline;
#[allow(dead_code)]
pub mod requirements;
#[allow(dead_code)]
pub mod review;
#[allow(dead_code)]
pub mod revision;
pub mod roadmap;
#[allow(dead_code)]
pub mod session;
pub mod verify;
pub mod vision;
