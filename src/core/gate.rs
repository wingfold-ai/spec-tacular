//! Whether an artifact may be generated yet.
//!
//! This is where the sequencing argument gets teeth. OpenSpec's `requires` is
//! satisfied by a file existing, so `design` unblocks the moment `specs/` is
//! written — not when anyone has agreed the specs are right
//! (docs/problem-analysis.md §1, §2). The gate adds the missing condition:
//! a prerequisite must be *accepted*, not merely present.
//!
//! Enforced in two places on purpose. The schema (`design.requires: [specs]`)
//! fixes the order for anyone running plain `openspec`; this fixes the
//! acceptance condition, which a schema cannot express.
//!
//! Lands in stage 2.
