//! The Foundation advisor: an AI that digs deeper where an answer leaves a
//! decision open, and proposes options for the questions still ahead.
//!
//! "Python" is not a stack — it leaves the version, the package manager and the
//! test runner undecided, and whatever the first change's agent picks for them
//! becomes an accident every later change inherits. The static questions cannot
//! know which follow-ups an answer needs; a model that sees the answer can.
//!
//! Two rules keep it honest:
//!   - It proposes, it never decides. Options are shown with one marked
//!     recommended, but nothing is written until a human picks one or types
//!     their own. The Foundation still holds only decisions somebody made.
//!   - It runs in the background. Setup never waits on it; a follow-up that
//!     arrives late is simply the next question.
//!
//! The model is reached through an injected `ask`, so this module knows nothing
//! about which agent answers — and is tested without one.
//!
//! Lands in stage 8.
