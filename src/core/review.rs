//! Review state — the thing OpenSpec does not have.
//!
//! OpenSpec decides an artifact is complete by checking that its file exists
//! (`artifact-graph/state.ts`). That cannot answer "which specs have been
//! finished off and accepted", so spec-tacular keeps acceptance in a sidecar
//! OpenSpec never reads.
//!
//! The sidecar is never trusted on its own. Every requirement carries the hash
//! of the text that was accepted, and every load re-hashes the Markdown and
//! compares. Files get edited outside this tool — by you, by an agent — and a
//! review tool that keeps claiming "accepted" for text nobody accepted is worse
//! than having no review tool at all.
//!
//! Lands in stage 2.
