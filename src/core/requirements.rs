//! Flattens a change's spec deltas into one ordered review queue.
//!
//! This is the data the review loop walks: every requirement across every
//! capability in a change, in document order, each one independently
//! reviewable. The pile-of-files problem (docs/problem-analysis.md §3) is
//! solved here, not in the UI — the UI only shows one element of this list at
//! a time.
//!
//! Lands in stage 2.
