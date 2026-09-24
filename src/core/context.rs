//! The context bundle handed to an agent with every call.
//!
//! Two jobs. It carries the project's ground rules, so generated specs and
//! designs are constrained by decisions already made rather than re-deciding
//! them per change (docs/problem-analysis.md §6, §9). And it states which
//! requirements a human has actually accepted, so an agent writing a design
//! knows what is settled and what is not.
//!
//! Foundation documents and ADRs are read if present and skipped if not, so
//! this works the moment those files exist rather than needing to be revisited.
//!
//! Lands in stage 3.
