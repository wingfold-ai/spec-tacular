//! spec-tacular entry point.
//!
//! `spectacular`          launch the TUI
//! `spectacular --print`  render the overview as text and exit
//!
//! `--print` is not a degraded mode: it is the same model rendered without a
//! terminal, which is what makes the overview usable in CI and over a pipe.
//!
//! This is the Rust port's stage 1. The command surface is complete and
//! parsed; the behaviour behind each command arrives in later stages, so every
//! command still declines rather than pretending to work.

mod adapter;
mod agent;
mod cli;
mod core;
mod render;
mod tui;

use std::process::ExitCode;

fn main() -> ExitCode {
    ExitCode::from(cli::run(std::env::args_os()))
}
