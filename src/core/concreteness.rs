//! The concreteness linter.
//!
//! Flags values a requirement names that the project may not have decided yet:
//! endpoints, identifiers, file paths, library names. It cannot know whether
//! any given one is a real contract — for a CLI tool the command names *are*
//! the contract — so it is advisory by construction and never blocks a stage.
//! Its job is to put the question in front of a human at review time, where it
//! is one keystroke to answer.
//!
//! Anything inside `{{example: ...}}` is never flagged: that is the reviewer
//! having already answered.
//!
//! Lands in stage 2.
