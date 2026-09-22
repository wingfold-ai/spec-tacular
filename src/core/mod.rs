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

pub mod advisor;
pub mod archive;
pub mod change_review;
pub mod concreteness;
pub mod context;
pub mod decisions;
pub mod examples;
pub mod foundation;
pub mod gate;
pub mod guide;
pub mod init;
pub mod jobs;
pub mod mark;
pub mod markdown;
pub mod naming;
pub mod pending;
pub mod pipeline;
pub mod requirements;
pub mod review;
pub mod revision;
pub mod roadmap;
pub mod session;
pub mod verify;
pub mod vision;
