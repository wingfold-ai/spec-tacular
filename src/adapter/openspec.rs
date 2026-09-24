//! The OpenSpec adapter — the ONLY module in spec-tacular that knows OpenSpec
//! exists.
//!
//! Two rules, both load-bearing (see docs/architecture.md):
//!   1. Reads go through the CLI's `--json` surface, which is a far more stable
//!      contract than OpenSpec's internal module paths.
//!   2. Nothing here ever writes a file OpenSpec owns. Mutations are delegated
//!      to OpenSpec's own commands, so the on-disk format stays compatible with
//!      plain `openspec` and with any agent that knows it.
//!
//! Lands in stage 3.
