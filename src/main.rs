//! spec-tacular entry point.
//!
//! `spectacular`          launch the TUI
//! `spectacular --print`  render the overview as text and exit
//!
//! `--print` is not a degraded mode: it is the same model rendered without a
//! terminal, which is what makes the overview usable in CI and over a pipe.
//!
//! The port lands bottom-up. The command surface is complete and parsed, and
//! the model behind it — parsing, review state, sessions, gates, the linter —
//! is complete and tested; wiring the two together arrives with the OpenSpec
//! adapter, so every command still declines rather than pretending to work.

// The port lands bottom-up: `core/`, `render/` and the `adapter/` types are
// complete before the CLI and the TUI that call them (stages 3 onwards), so
// most of the model is for now reachable only from its own tests, which
// `dead_code` reports as unused. The alternative — landing each piece of the
// model in the same pull request as its first caller — is the giant,
// unreviewable PR the stacked port exists to avoid. The allow comes off as the
// stages above wire each module in.
#[allow(dead_code)]
mod adapter;
mod agent;
mod cli;
#[allow(dead_code)]
mod core;
#[allow(dead_code)]
mod render;
mod tui;

use std::process::ExitCode;

fn main() -> ExitCode {
    ExitCode::from(cli::run(std::env::args_os()))
}
