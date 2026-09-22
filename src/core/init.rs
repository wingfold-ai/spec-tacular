//! Installs spec-tacular's schema into an OpenSpec project.
//!
//! The schema is what enforces `proposal → specs → design → tasks` for anyone
//! running plain `openspec`, without spec-tacular in the loop
//! (docs/problem-analysis.md §1). Its one substantive change from `spec-driven`
//! is `design.requires: [specs]` instead of `[proposal]`; the rest is
//! instruction wording for abstraction, example marking and deferral.
//!
//! Lands in stage 3.
