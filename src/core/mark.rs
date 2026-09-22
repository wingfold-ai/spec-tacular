//! Marking a flagged value as an example, in place.
//!
//! This writes to a spec file, which the adapter rule otherwise forbids. The
//! exception is deliberate and narrow: that rule exists so spec-tacular never
//! creates, archives or restructures OpenSpec's artifacts behind its back. This
//! is a human editing the prose of one requirement — the same thing `e` does
//! through `$EDITOR`, minus the round trip — and it changes no structure.
//!
//! It is a pure substitution inside one requirement's block. Everything else in
//! the file is left byte-for-byte alone, and if the target cannot be located
//! unambiguously it declines rather than guessing.
//!
//! Lands in stage 2.
