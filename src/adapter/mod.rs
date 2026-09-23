//! The boundary between spec-tacular and OpenSpec.
//!
//! Everything that knows OpenSpec exists lives under here, and nothing outside
//! it does. `core/` is written against plain data; swapping, versioning or
//! stubbing OpenSpec is therefore a change to this directory alone
//! (docs/architecture.md).

/// A stand-in `openspec` for tests. Lives beside the adapter because it is
/// the adapter's contract with a subprocess that it stands in for.
#[cfg(all(test, unix))]
pub mod fake;
// Stage 3 calls `status_all` and `instructions`, stage 4 `archive`, and the
// TUI in stage 5 `init`, `new_change`, `template` and `artifact_file`;
// `validate` and `version` wait for later stages, and they are here because
// the rule is that everything OpenSpec-shaped lives in one file, not that it
// lands in one stage.
#[allow(dead_code)]
pub mod openspec;
pub mod types;
