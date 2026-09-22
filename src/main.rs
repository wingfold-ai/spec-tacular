//! spec-tacular entry point.
//!
//! `spectacular`          launch the TUI
//! `spectacular --print`  render the overview as text and exit
//!
//! `--print` is not a degraded mode: it is the same model rendered without a
//! terminal, which is what makes the overview usable in CI and over a pipe.
//!
//! The port lands bottom-up. `init`, `instructions`, `foundation`, `adr` and
//! the `--print` overview are wired through the OpenSpec adapter and do their
//! work; the background jobs and the archive half (stage 4) and the TUI
//! (stage 5) still decline rather than pretending to work.

mod adapter;
mod agent;
mod cli;
mod commands;
mod core;
mod render;
mod tui;

use std::process::ExitCode;

fn main() -> ExitCode {
    ExitCode::from(cli::run(std::env::args_os()))
}
