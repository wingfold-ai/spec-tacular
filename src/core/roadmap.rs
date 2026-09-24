//! The roadmap: a vision decomposed into an ordered list of slices.
//!
//! OpenSpec's model is a *change* against an existing baseline — its README
//! says so. On day one there is no baseline, so a vision decomposes into a
//! dozen parallel changes with no sequencing, and every one needs full review
//! before any code exists (docs/problem-analysis.md §4).
//!
//! The roadmap is reviewed first, cheaply: one line per slice. Changes then
//! open one slice at a time, so the review queue never exceeds one change.
//!
//! Lands in stage 4.
