//! Renders one requirement for review.
//!
//! One requirement, full width, nothing else competing for attention. The
//! failure mode being fixed is a wall of requirements; recreating that wall in
//! a TUI would fix nothing (docs/tui-design.md).
//!
//! Shared by the TUI and by `--print`, so the two can never disagree about what
//! a requirement looks like.
//!
//! Lands in stage 3.
