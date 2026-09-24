//! The words shown where a project has nothing in it yet, and the help.
//!
//! The TypeScript `guide.tsx`. Every empty state names the next step and the
//! key that takes it: a blank screen with "0 changes" is accurate and useless
//! — the person looking at it is exactly the one who does not yet know which
//! command comes next. The stepper itself is [`super::widgets::stepper_line`].

use ratatui::style::Style;
use ratatui::text::{Line, Span};

use super::theme;

/// The overview body when the ground rules are set and nothing is proposed.
pub const FIRST_CHANGE_LINES: [&str; 14] = [
    "Ground rules are set. Next: your first change.",
    "",
    "A change is one slice of work, small enough to review in one sitting —",
    "\"add user login\", not \"build the app\". It moves through four artifacts,",
    "and each one waits until you have accepted the one before it:",
    "",
    "  proposal   why this change, and what it changes",
    "  specs      the requirements, which you review one at a time",
    "  design     how it will be built, decided against accepted specs",
    "  tasks      the implementation checklist an agent works through",
    "",
    "Press n (or + New change) and describe what you want in a sentence or",
    "two — a name is proposed from it. Then an agent drafts the proposal, or",
    "you write it yourself.",
];

/// Every overview key, and what the pipeline marks mean.
pub const HELP_LINES: [&str; 17] = [
    "Overview",
    "  ↑ / ↓, j / k   select a change (or click it)",
    "  ← / →, tab     choose between the next-step buttons",
    "  enter          press the highlighted button — the next step",
    "  r              review the selected change, one requirement at a time",
    "  n              start a new change",
    "  w              let an agent draft the next artifact, in the background",
    "  e              write the next artifact yourself, in $EDITOR",
    "  f              the ground rules: stack, domain, architecture, conventions",
    "  ctrl+j         background jobs",
    "  h              back to the start screen",
    "  q              quit",
    "",
    "Pipeline marks",
    "  ✓ accepted by you   ● written, not yet accepted   ◉ ready to write   ○ blocked",
    "",
    "Press any key to close.",
];

/// The first-change guide, styled: its first line is the heading.
pub fn first_change_lines() -> Vec<Line<'static>> {
    FIRST_CHANGE_LINES
        .iter()
        .enumerate()
        .map(|(i, line)| {
            let color = if i == 0 { theme::ACCENT } else { theme::TEXT };
            Line::from(Span::styled(*line, Style::default().fg(color)))
        })
        .collect()
}

/// The help, styled: an unindented line is a heading.
pub fn help_lines() -> Vec<Line<'static>> {
    HELP_LINES
        .iter()
        .map(|line| {
            let color = if !line.is_empty() && !line.starts_with(' ') {
                theme::ACCENT
            } else {
                theme::TEXT
            };
            Line::from(Span::styled(*line, Style::default().fg(color)))
        })
        .collect()
}
