//! The `{{example: ...}}` notation.
//!
//! Specs come back naming endpoints, table names and classes that nobody has
//! decided yet (docs/problem-analysis.md §5). Instructions alone demonstrably
//! do not hold — OpenSpec's own schema already says "avoid implementation
//! detail" and you still get endpoint names — so the distinction is made
//! explicit instead: an unmarked concrete value is a binding contract, a marked
//! one is an illustration.
//!
//! Marking is part of the requirement's text, so it changes the hash and resets
//! acceptance. That is correct: it changes what the requirement promises.
//!
//! Lands in stage 2.
