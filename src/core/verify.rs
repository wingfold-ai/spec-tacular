//! Verifying a pending requirement into the accepted baseline.
//!
//! This is the only place spec-tacular writes to `openspec/specs/`, which the
//! adapter rule otherwise forbids. There is no OpenSpec command for "add this
//! requirement to a main spec" — archive is the only path in, and the whole
//! point of the register is that these requirements missed it.
//!
//! So the write is made as conservative as possible: the requirement block goes
//! in verbatim under the spec's `## Requirements` section, formatted by the
//! same rules the parser reads, and the caller is expected to run
//! `openspec validate` afterwards to confirm OpenSpec still accepts the file.
//!
//! Lands in stage 4.
