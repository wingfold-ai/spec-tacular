//! The pipeline model: OpenSpec's artifact list turned into the stage view that
//! is always on screen.
//!
//! Deliberately schema-agnostic. Stages are derived from whatever artifacts the
//! change's schema declares, in dependency order, so this works unchanged with
//! `spec-driven`, with spec-tacular's own schema, and with any custom schema a
//! project forks.
//!
//! Two different truths live here and must not be confused. `written` is
//! OpenSpec's: the file exists. `accepted` is spec-tacular's: a human reviewed
//! every requirement in it. An artifact with no review data can only ever reach
//! `written`, never `accepted` — absence of review is never evidence of review.
//!
//! Lands in stage 2.
