//! Markdown primitives, deliberately mirroring OpenSpec's own parsers.
//!
//! These patterns and normalization rules are ported from
//! `src/core/parsers/{requirement-blocks,requirement-text,spec-structure,code-fence}.ts`
//! in @fission-ai/openspec. spec-tacular must agree with OpenSpec about what a
//! requirement *is* — a requirement this parser cannot see is one a human can
//! never review, and one it invents is one that does not exist. Any divergence
//! here is a bug, so the rules are kept together and cited rather than
//! re-derived.
//!
//! Lands in stage 2.
