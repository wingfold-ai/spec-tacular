//! spec-tacular entry point.
//!
//! `spectacular`          launch the TUI
//! `spectacular --print`  render the overview as text and exit
//!
//! `--print` is not a degraded mode: it is the same model rendered without a
//! terminal, which is what makes the overview usable in CI and over a pipe.
//!
//! The port lands bottom-up. Stage 4 closed the command surface — every
//! subcommand does its work — and stage 5 replaced the last placeholder: with
//! no subcommand, on a terminal, `spectacular` opens the TUI, set up or not.

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
