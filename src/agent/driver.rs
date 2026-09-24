//! Agent drivers.
//!
//! spec-tacular does not talk to a model. It builds a prompt and hands it to
//! whichever coding agent you already use, as a subprocess. Keeping that behind
//! a trait is deliberate: hardcoding one vendor would make the tool useless to
//! anyone using another, and the whole point of building on OpenSpec is that it
//! works with the tools you have.
//!
//! Lands in stage 4.
