//! The pending-validation register.
//!
//! OpenSpec's archive counts unchecked boxes in `tasks.md` and blocks, offering
//! only `--yes` (archive anyway, losing the record of what was never verified)
//! or `--skip-specs` (archive without merging specs at all). Both are
//! all-or-nothing: there is no way to say *these requirements are verified,
//! that one waits for a deployed environment* (docs/problem-analysis.md §8).
//!
//! The register is that missing middle. A deferred requirement leaves the
//! change but does not enter the accepted baseline — it waits here, in full,
//! with what would verify it, until someone can.
//!
//! Lands in stage 4.
