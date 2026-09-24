//! The archive split.
//!
//! Accepted requirements merge into `openspec/specs/` through OpenSpec's own
//! archive; deferred ones divert to the pending-validation register instead. A
//! change whose only outstanding work needs a deployed environment closes
//! cleanly, and what was never verified stays visible and out of the accepted
//! baseline (docs/problem-analysis.md §8).
//!
//! This rewrites a change's delta files before archiving, which the adapter
//! rule otherwise forbids. The exception is narrow and the content is never
//! lost: every removed requirement is written to the register first, in full,
//! with what would verify it. Preparation is a separate, inspectable step from
//! the archive itself precisely because it edits files.
//!
//! Lands in stage 4.
