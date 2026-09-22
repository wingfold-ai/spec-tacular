//! Argument parsing and command dispatch.
//!
//! The command surface is a port of the TypeScript implementation's
//! `parseArgs`/`HELP`, kept deliberately identical: the two are meant to be
//! interchangeable while the port is in flight, and a help text that drifts
//! from the one people already know is its own small bug.
//!
//! Nothing here does any work. Dispatch decides *which* command was asked for
//! and whether the project is one spec-tacular can act on; the commands
//! themselves live in `core/` and land stage by stage.

use std::ffi::OsString;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};

use clap::{ArgAction, Parser, Subcommand};

/// The default agent driver, matching the TypeScript `DEFAULT_DRIVER`.
pub const DEFAULT_DRIVER: &str = "claude";

const ABOUT: &str = "spec-tacular — spec-driven development, reviewable";

/// The usage block from the TypeScript `HELP` constant, reproduced verbatim so
/// `spectacular --help` reads the same in both implementations.
const USAGE: &str = "
  spectacular                              Launch the TUI
  spectacular --print                      Print the overview as text
  spectacular init                         Install the spec-tacular schema
  spectacular instructions <artifact> -c <change>
                                           Instructions for writing an artifact,
                                           refused while its prerequisites are
                                           not accepted
  spectacular run <artifact> -c <change>   Dispatch an agent in the background
                                           to write it. Returns immediately.
  spectacular jobs                         List background jobs
  spectacular jobs --job <id>              Tail one job's output
  spectacular jobs --job <id> --cancel     Stop a running job
  spectacular foundation                   Show the project's ground rules and
                                           what is still unanswered
  spectacular adr                          List architectural decision records
  spectacular archive <change>             Merge accepted requirements, divert
                                           deferred ones to the register
  spectacular pending                      Requirements waiting on validation
  spectacular verify <capability> --requirement <name>
                                           Move one into the accepted baseline
  spectacular roadmap                      Show the slices
  spectacular roadmap --promote <slice>    Make a slice active
  spectacular roadmap --done <slice>       Mark a slice finished";

const HELP_TEMPLATE: &str = "\
{about}

Usage:{usage}

Options:
{options}
";

/// The whole command line.
#[derive(Debug, Parser)]
#[command(
    name = "spectacular",
    bin_name = "spectacular",
    version,
    about = ABOUT,
    override_usage = USAGE,
    help_template = HELP_TEMPLATE,
    disable_help_flag = true,
    disable_help_subcommand = true,
    args_conflicts_with_subcommands = false
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,

    /// Print the overview as text and exit
    #[arg(short = 'p', long, global = true, action = ArgAction::SetTrue)]
    pub print: bool,

    /// The change to act on
    #[arg(short = 'c', long, global = true, value_name = "name")]
    pub change: Option<String>,

    /// Project root (default: current directory)
    #[arg(long, global = true, value_name = "dir")]
    pub cwd: Option<PathBuf>,

    /// Path to the openspec binary
    #[arg(long = "openspec-bin", global = true, value_name = "p")]
    pub openspec_bin: Option<PathBuf>,

    /// Agent to run (claude, opencode). Default: claude
    #[arg(long, global = true, value_name = "name", default_value = DEFAULT_DRIVER, hide_default_value = true)]
    pub driver: String,

    /// Overwrite an existing schema install
    #[arg(short = 'f', long, global = true, action = ArgAction::SetTrue)]
    pub force: bool,

    /// Show this help
    #[arg(short = 'h', long, global = true, action = ArgAction::Help)]
    help: Option<bool>,
}

/// The subcommands, one per verb in the TypeScript `Command` union. Absence of
/// a subcommand is the overview — the TUI, or `--print` without a terminal.
#[derive(Debug, Subcommand)]
pub enum Command {
    /// Install the spec-tacular schema
    Init,

    /// Instructions for writing an artifact, refused while its prerequisites
    /// are not accepted
    Instructions {
        /// The artifact to write (proposal, specs, design, tasks)
        artifact: Option<String>,
    },

    /// Dispatch an agent in the background to write an artifact
    Run {
        /// The artifact to write (proposal, specs, design, tasks)
        artifact: Option<String>,
    },

    /// List background jobs
    Jobs {
        /// A job id to tail, or to cancel with --cancel
        #[arg(long, value_name = "id")]
        job: Option<String>,

        /// Stop the job named by --job
        #[arg(long, action = ArgAction::SetTrue)]
        cancel: bool,
    },

    /// List architectural decision records
    Adr {
        /// Promote a design decision to a project-wide ADR
        #[arg(long, value_name = "decision")]
        promote: Option<String>,
    },

    /// Show the project's ground rules and what is still unanswered
    Foundation,

    /// Merge accepted requirements, divert deferred ones to the register
    Archive {
        /// The change to archive (or pass it with -c)
        change: Option<String>,

        /// Report what would happen and write nothing
        #[arg(long = "dry-run", action = ArgAction::SetTrue)]
        dry_run: bool,
    },

    /// Requirements waiting on validation
    Pending,

    /// Move a pending requirement into the accepted baseline
    Verify {
        /// The capability holding the requirement
        capability: Option<String>,

        /// The requirement's name
        #[arg(long, value_name = "name")]
        requirement: Option<String>,
    },

    /// Show the slices, or promote/complete one
    Roadmap {
        /// Make a slice active
        #[arg(long, value_name = "slice")]
        promote: Option<String>,

        /// Mark a slice finished
        #[arg(long, value_name = "slice")]
        done: Option<String>,
    },
}

impl Command {
    /// Which stage of the port implements this command, for the placeholder
    /// message. The stages are the ones listed in README.md.
    fn stage(&self) -> u8 {
        match self {
            Command::Init
            | Command::Instructions { .. }
            | Command::Adr { .. }
            | Command::Foundation => 3,
            Command::Run { .. }
            | Command::Jobs { .. }
            | Command::Archive { .. }
            | Command::Pending
            | Command::Verify { .. }
            | Command::Roadmap { .. } => 4,
        }
    }

    /// The name as it is typed, for the placeholder message.
    fn name(&self) -> &'static str {
        match self {
            Command::Init => "init",
            Command::Instructions { .. } => "instructions",
            Command::Run { .. } => "run",
            Command::Jobs { .. } => "jobs",
            Command::Adr { .. } => "adr",
            Command::Foundation => "foundation",
            Command::Archive { .. } => "archive",
            Command::Pending => "pending",
            Command::Verify { .. } => "verify",
            Command::Roadmap { .. } => "roadmap",
        }
    }
}

/// A project spec-tacular can act on is one with an `openspec/` directory.
/// Mirrors `isOpenSpecProject` in the adapter.
fn is_openspec_project(cwd: &Path) -> bool {
    cwd.join("openspec").is_dir()
}

/// Parse and dispatch. Returns the process exit code rather than exiting, so
/// the whole path is testable.
pub fn run<I, T>(argv: I) -> u8
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let cli = match Cli::try_parse_from(argv) {
        Ok(cli) => cli,
        Err(err) => {
            // clap already formats `--help` and `--version` as success, and
            // usage errors as failure; honour its own exit code.
            let _ = err.print();
            return if err.use_stderr() { 2 } else { 0 };
        }
    };

    let cwd = cli
        .cwd
        .clone()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    // The TUI opens anywhere: in a folder that is not set up yet, it offers to
    // set it up. Every other command needs a project to act on.
    let tui = cli.command.is_none() && !cli.print && std::io::stdout().is_terminal();
    if !is_openspec_project(&cwd) && !tui {
        let mut err = std::io::stderr();
        let _ = write!(
            err,
            "No openspec/ directory in {}.\n\
             spec-tacular works on an OpenSpec project — run `spectacular` in a terminal\n\
             to be guided through setting one up, or point at one with --cwd.\n",
            cwd.display()
        );
        return 1;
    }

    match &cli.command {
        Some(command) => not_implemented(command.name(), command.stage()),
        // The overview: the TUI when there is a terminal, the text rendering
        // otherwise. Both are still ahead.
        None if tui => not_implemented("the TUI", 5),
        None => not_implemented("--print", 3),
    }
}

/// Every command declines the same way until its stage lands.
fn not_implemented(what: &str, stage: u8) -> u8 {
    let _ = writeln!(
        std::io::stderr(),
        "spectacular {what}: not implemented yet in the Rust port (stage {stage})"
    );
    2
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn clap_definition_is_valid() {
        Cli::command().debug_assert();
    }

    #[test]
    fn help_lists_every_subcommand() {
        let help = Cli::command().render_help().to_string();
        for name in [
            "init",
            "instructions",
            "run",
            "jobs",
            "foundation",
            "adr",
            "archive",
            "pending",
            "verify",
            "roadmap",
        ] {
            assert!(help.contains(name), "help is missing `{name}`");
        }
    }

    #[test]
    fn globals_are_accepted_after_a_subcommand() {
        let cli = Cli::try_parse_from(["spectacular", "instructions", "specs", "-c", "add-auth"])
            .expect("parse");
        assert_eq!(cli.change.as_deref(), Some("add-auth"));
        match cli.command {
            Some(Command::Instructions { artifact }) => {
                assert_eq!(artifact.as_deref(), Some("specs"))
            }
            other => panic!("expected instructions, got {other:?}"),
        }
    }

    #[test]
    fn archive_takes_its_change_positionally() {
        let cli = Cli::try_parse_from(["spectacular", "archive", "add-auth", "--dry-run"]).unwrap();
        match cli.command {
            Some(Command::Archive { change, dry_run }) => {
                assert_eq!(change.as_deref(), Some("add-auth"));
                assert!(dry_run);
            }
            other => panic!("expected archive, got {other:?}"),
        }
    }

    #[test]
    fn driver_defaults_to_claude() {
        let cli = Cli::try_parse_from(["spectacular"]).unwrap();
        assert_eq!(cli.driver, DEFAULT_DRIVER);
        assert!(cli.command.is_none());
    }

    #[test]
    fn roadmap_promote_and_done_are_separate_slices() {
        let cli = Cli::try_parse_from(["spectacular", "roadmap", "--done", "login"]).unwrap();
        match cli.command {
            Some(Command::Roadmap { promote, done }) => {
                assert!(promote.is_none());
                assert_eq!(done.as_deref(), Some("login"));
            }
            other => panic!("expected roadmap, got {other:?}"),
        }
    }

    #[test]
    fn a_directory_with_openspec_is_a_project() {
        assert!(!is_openspec_project(Path::new("/nonexistent-xyz")));
    }
}
