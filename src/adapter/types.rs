//! The shape of `openspec ... --json` output that spec-tacular relies on.
//!
//! These mirror OpenSpec's published CLI contract, not its internal modules —
//! the CLI's JSON surface is the more stable of the two. Fields spec-tacular
//! does not use are deliberately omitted; deserialization ignores extras so an
//! upstream addition is never a breaking change.
//!
//! Lands in stage 3.
