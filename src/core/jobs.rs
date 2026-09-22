//! Background jobs.
//!
//! The reason this exists: `openspec apply` occupies your session, so
//! reviewing while implementing means a second terminal and a second agent
//! instance managed by hand (docs/problem-analysis.md §7). Here a job is
//! dispatched, its output streams to a file, and the review loop keeps running.
//!
//! Jobs are spawned detached and recorded on disk, so quitting the TUI does not
//! kill work in progress and relaunching finds it again.
//!
//! Lands in stage 4.
