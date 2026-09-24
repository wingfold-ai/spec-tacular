//! Argument parsing and command dispatch.
//!
//! The command surface is a port of the TypeScript implementation's
//! `parseArgs`/`HELP`, kept deliberately identical: the two are meant to be
//! interchangeable while the port is in flight, and a help text that drifts
//! from the one people already know is its own small bug.
//!
//! Nothing here does any work. Dispatch decides *which* command was asked for
//! and whether the project is one spec-tacular can act on; what each command
//! does lives in `commands.rs`, over `core/` and `adapter/`. Every subcommand
//! now does its work; only the TUI still declines rather than pretending.

use std::ffi::OsString;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};

use clap::{ArgAction, Parser, Subcommand};

use crate::adapter::openspec::{is_openspec_project, OpenSpecAdapter, OpenSpecError};
use crate::commands::{self, Streams};

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
    ///
    /// Listing only. Promotion is a review action, not a command: you press
    /// `p` on a decision in the TUI, which is where you are when you find out
    /// a decision is architectural.
    Adr,

    /// Show the project's ground rules and what is still unanswered
    Foundation,

    /// Merge accepted requirements, divert deferred ones to the register
    Archive {
        // Two ways to name the change, and they are not equal. The TypeScript
        // parser fell back to this positional *only when `-c` was not given*
        // (src/cli.ts:140, `if (second && !args.change) args.change = second`),
        // so `-c` wins on a conflict and the positional is the shorthand.
        // `cli.rs` reconciles them at dispatch, because clap parses both.
        //
        // The id is not `change`: a positional sharing the global `--change`
        // flag's id shadows it here, and `spectacular archive x -c y` would be
        // a usage error rather than the precedence above.
        /// The change to archive (or pass it with -c)
        #[arg(id = "archive-change", value_name = "change")]
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

    let stdout = std::io::stdout();
    let stderr = std::io::stderr();
    let mut out = stdout.lock();
    let mut err = stderr.lock();
    let mut io = Streams {
        out: &mut out,
        err: &mut err,
    };

    match &cli.command {
        Some(Command::Init) => commands::run_init(&cwd, cli.force, &mut io),
        Some(Command::Adr) => commands::run_adrs(&cwd, &mut io),
        Some(Command::Foundation) => commands::run_foundation(&cwd, &mut io),
        Some(Command::Pending) => commands::run_pending(&cwd, &mut io),
        Some(Command::Jobs { job, cancel }) => {
            commands::run_jobs(&cwd, job.as_deref(), *cancel, &mut io)
        }
        Some(Command::Roadmap { promote, done }) => {
            commands::run_roadmap(&cwd, promote.as_deref(), done.as_deref(), &mut io)
        }
        Some(Command::Instructions { artifact }) => {
            let Some(runtime) = runtime(&mut io) else {
                return 1;
            };
            let adapter = adapter(&cli, &cwd);
            let result = runtime.block_on(commands::run_instructions(
                &adapter,
                &cwd,
                artifact.as_deref(),
                cli.change.as_deref(),
                &mut io,
            ));
            report(result, &mut io)
        }
        Some(Command::Run { artifact }) => {
            let Some(runtime) = runtime(&mut io) else {
                return 1;
            };
            let adapter = adapter(&cli, &cwd);
            let result = runtime.block_on(commands::run_agent(
                &adapter,
                &cwd,
                artifact.as_deref(),
                cli.change.as_deref(),
                &cli.driver,
                &mut io,
            ));
            report(result, &mut io)
        }
        Some(Command::Archive { change, dry_run }) => {
            let Some(runtime) = runtime(&mut io) else {
                return 1;
            };
            let adapter = adapter(&cli, &cwd);
            // `-c` wins over the positional, as the TypeScript parser had it:
            // the fallback only fired when `--change` was absent.
            let change = cli.change.as_deref().or(change.as_deref());
            let result = runtime.block_on(commands::run_archive(
                &adapter, &cwd, change, *dry_run, &mut io,
            ));
            report(result, &mut io)
        }
        Some(Command::Verify {
            capability,
            requirement,
        }) => {
            let Some(runtime) = runtime(&mut io) else {
                return 1;
            };
            let adapter = adapter(&cli, &cwd);
            let result = runtime.block_on(commands::run_verify(
                &adapter,
                &cwd,
                capability.as_deref(),
                requirement.as_deref(),
                &mut io,
            ));
            report(result, &mut io)
        }
        // The TUI is stage 5. Everything it would show is already here — the
        // overview below is the same model, rendered without a terminal.
        None if tui => not_implemented("the TUI", 5),
        None => {
            let Some(runtime) = runtime(&mut io) else {
                return 1;
            };
            let adapter = adapter(&cli, &cwd);
            let color = std::io::stdout().is_terminal();
            let result = runtime.block_on(commands::run_overview(&adapter, &cwd, color, &mut io));
            report(result, &mut io)
        }
    }
}

fn adapter(cli: &Cli, cwd: &Path) -> OpenSpecAdapter {
    OpenSpecAdapter::new(cwd, cli.openspec_bin.clone())
}

/// The runtime the OpenSpec-facing commands wait on.
///
/// Current-thread: each of them waits on one subprocess, so a thread pool would
/// buy nothing and cost startup — the thing the port exists to fix.
fn runtime(io: &mut Streams<'_>) -> Option<tokio::runtime::Runtime> {
    match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => Some(runtime),
        Err(error) => {
            io.err(format!("Could not start the async runtime: {error}\n"));
            None
        }
    }
}

/// Reports an OpenSpec failure the way the TypeScript `main` did: the message,
/// then the hint on its own line, then exit 1.
fn report(result: Result<u8, OpenSpecError>, io: &mut Streams<'_>) -> u8 {
    match result {
        Ok(code) => code,
        Err(error) => {
            io.err(format!("{}\n", error.message));
            if let Some(hint) = error.hint {
                io.err(format!("{hint}\n"));
            }
            1
        }
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
        let cli = Cli::try_parse_from(["spectacular", "archive", "add-auth", "--dry-run"])
            .expect("parse");
        match cli.command {
            Some(Command::Archive { change, dry_run }) => {
                assert_eq!(change.as_deref(), Some("add-auth"));
                assert!(dry_run);
            }
            other => panic!("expected archive, got {other:?}"),
        }
    }

    #[test]
    fn archive_still_accepts_the_change_as_a_flag() {
        // The positional and `-c` are both spellings of one thing, and the
        // positional must not shadow the global flag.
        let cli = Cli::try_parse_from(["spectacular", "archive", "add-auth", "-c", "other"])
            .expect("parse");
        assert_eq!(cli.change.as_deref(), Some("other"));
        match cli.command {
            Some(Command::Archive { change, .. }) => {
                assert_eq!(change.as_deref(), Some("add-auth"))
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

    #[test]
    fn every_verb_now_runs_rather_than_declining() {
        // Stage 4 is the last one that removes a placeholder from a
        // subcommand. Only the TUI still declines, and it is not a subcommand.
        let help = Cli::command().render_help().to_string();
        assert!(!help.contains("not implemented"), "{help}");
    }
}
