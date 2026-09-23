//! The few building blocks every screen is made of: panels, buttons, a spinner
//! and the key bar. Shared so the screens read as one interface rather than as
//! separate text dumps.

use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Paragraph};
use ratatui::Frame;

use super::theme;
use crate::render::requirement::wrap;

/// The braille frames the spinner cycles through.
const FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// One frame of the spinner, for the tick the app is on.
pub fn spinner_frame(tick: usize) -> &'static str {
    FRAMES[tick % FRAMES.len()]
}

/// Cuts a line to `max` characters, marking the cut.
pub fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let kept: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{kept}…")
}

/// A path as a header shows it: `~` for home, and the tail kept when long.
pub fn short_path(path: &str, max: usize) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let shown = if !home.is_empty() && path.starts_with(&home) {
        format!("~{}", &path[home.len()..])
    } else {
        path.to_owned()
    };
    let len = shown.chars().count();
    if len <= max {
        return shown;
    }
    let tail: String = shown
        .chars()
        .skip(len.saturating_sub(max.saturating_sub(1)))
        .collect();
    format!("…{tail}")
}

/// A bordered panel with its title set into the top edge.
pub fn panel(title: Option<&str>, focused: bool) -> Block<'static> {
    let border = if focused {
        theme::ACCENT
    } else {
        theme::BORDER
    };
    let mut block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(border))
        .style(Style::default().bg(theme::PANEL));
    if let Some(title) = title {
        block = block.title(Span::styled(
            format!(" {title} "),
            Style::default().fg(if focused { theme::ACCENT } else { theme::TEXT }),
        ));
    }
    block
}

/// A button: keyboard-focusable and clickable.
///
/// `primary` outlines it in the second accent and letters it in the first —
/// one per screen, so the next step is never ambiguous. Focus fills it, as in
/// the TypeScript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Button {
    pub label: String,
    pub primary: bool,
}

impl Button {
    pub fn new(label: impl Into<String>, primary: bool) -> Self {
        Self {
            label: label.into(),
            primary,
        }
    }

    /// Border plus two columns of padding on each side, as the TypeScript's
    /// box model produced.
    pub fn width(&self) -> u16 {
        u16::try_from(self.label.chars().count().saturating_add(6)).unwrap_or(u16::MAX)
    }
}

/// Three rows: a button is a bordered box, and a box needs its edges.
pub const BUTTON_HEIGHT: u16 = 3;

/// Where each button in a row lands, so a click can be matched to one.
///
/// Buttons flow left to right and wrap onto another three-row line when the
/// next one would overflow, as a flex row that is allowed to wrap does. One
/// that fits on no line — the area is too short — is given no rect and is not
/// drawn: half a button is worse than none, and the key hint on each still
/// works.
pub fn button_rects(area: Rect, buttons: &[Button]) -> Vec<Option<Rect>> {
    let right = area.x.saturating_add(area.width);
    let bottom = area.y.saturating_add(area.height);
    let (mut x, mut y) = (area.x, area.y);
    buttons
        .iter()
        .map(|button| {
            let width = button.width().min(area.width);
            if x > area.x && x.saturating_add(width) > right {
                x = area.x;
                y = y.saturating_add(BUTTON_HEIGHT);
            }
            if width == 0 || y.saturating_add(BUTTON_HEIGHT) > bottom {
                return None;
            }
            let rect = Rect {
                x,
                y,
                width,
                height: BUTTON_HEIGHT,
            };
            // One column of margin, as `marginRight: 1` gave it.
            x = x.saturating_add(width).saturating_add(1);
            Some(rect)
        })
        .collect()
}

/// How many rows a set of buttons needs at `width`: three per line of them.
pub fn buttons_height(width: u16, buttons: &[Button]) -> u16 {
    if buttons.is_empty() {
        return 0;
    }
    let rects = button_rects(Rect::new(0, 0, width, u16::MAX), buttons);
    rects
        .iter()
        .flatten()
        .map(|r| r.y.saturating_add(r.height))
        .max()
        .unwrap_or(0)
}

/// Draws a row of buttons, returning where each landed.
pub fn render_buttons(
    frame: &mut Frame<'_>,
    area: Rect,
    buttons: &[Button],
    focus: Option<usize>,
) -> Vec<Option<Rect>> {
    let rects = button_rects(area, buttons);
    for (i, (button, rect)) in buttons.iter().zip(rects.iter()).enumerate() {
        let Some(rect) = rect else { continue };
        let focused = focus == Some(i);
        let border = if focused {
            theme::ACCENT
        } else if button.primary {
            theme::ACCENT2
        } else {
            theme::BORDER
        };
        let (fg, bg) = if focused {
            (theme::ON_ACCENT, theme::ACCENT)
        } else if button.primary {
            (theme::ACCENT, theme::PANEL)
        } else {
            (theme::TEXT, theme::PANEL)
        };
        let block = Block::bordered()
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(border))
            .style(Style::default().bg(bg));
        let text = Paragraph::new(Line::from(Span::styled(
            format!("  {}  ", button.label),
            Style::default().fg(fg).bg(bg),
        )))
        .block(block);
        frame.render_widget(text, *rect);
    }
    rects
}

/// `key action` chips, with a notice on its own line above them — a long
/// message squeezed in beside the keys garbles both.
pub fn render_key_bar(
    frame: &mut Frame<'_>,
    area: Rect,
    keys: &[(&str, &str)],
    notice: Option<&str>,
) {
    let mut lines: Vec<Line<'static>> = Vec::new();
    if let Some(notice) = notice {
        lines.push(Line::from(Span::styled(
            clip(notice, usize::from(area.width.saturating_sub(2))),
            Style::default().fg(theme::WARN),
        )));
    }
    let mut spans: Vec<Span<'static>> = Vec::new();
    for (key, action) in keys {
        spans.push(Span::styled(
            format!(" {key} "),
            Style::default().fg(theme::ON_ACCENT).bg(theme::DIM),
        ));
        spans.push(Span::styled(
            format!(" {action}  "),
            Style::default().fg(theme::DIM),
        ));
    }
    lines.push(Line::from(spans));
    frame.render_widget(
        Paragraph::new(lines).style(Style::default().bg(theme::BG)),
        area,
    );
}

/// `✓ Set up ── 2. Ground rules ── 3. Vision ── 4. First change`.
pub fn stepper_line(step: usize, steps: &[&str]) -> Line<'static> {
    let mut spans: Vec<Span<'static>> = Vec::new();
    for (i, label) in steps.iter().enumerate() {
        let color = match i.cmp(&step) {
            std::cmp::Ordering::Less => theme::OK,
            std::cmp::Ordering::Equal => theme::ACCENT,
            std::cmp::Ordering::Greater => theme::DIM,
        };
        let head = if i < step {
            "✓".to_owned()
        } else {
            format!("{}.", i + 1)
        };
        let tail = if i < steps.len() - 1 {
            "  ──  "
        } else {
            ""
        };
        spans.push(Span::styled(
            format!("{head} {label}{tail}"),
            Style::default().fg(color),
        ));
    }
    Line::from(spans)
}

/// A line in the palette's secondary colour.
pub fn dim(text: impl Into<String>) -> Line<'static> {
    Line::from(Span::styled(text.into(), Style::default().fg(theme::DIM)))
}

/// A column that lines, wrapped text and button rows are stacked into, top
/// to bottom — the flex column every TypeScript screen was built from.
///
/// Whatever falls below the area is not drawn, but still advances the cursor.
pub struct Flow {
    pub area: Rect,
    pub y: u16,
}

impl Flow {
    pub fn new(area: Rect) -> Self {
        Self { area, y: area.y }
    }

    fn bottom(&self) -> u16 {
        self.area.y.saturating_add(self.area.height)
    }

    /// Rows left below the cursor.
    pub fn remaining(&self) -> u16 {
        self.bottom().saturating_sub(self.y)
    }

    /// One line, cut at the area's edge.
    pub fn line(&mut self, frame: &mut Frame<'_>, line: Line<'static>) {
        if self.y < self.bottom() {
            let rect = Rect::new(self.area.x, self.y, self.area.width, 1);
            frame.render_widget(Paragraph::new(line), rect);
        }
        self.y = self.y.saturating_add(1);
    }

    pub fn blank(&mut self) {
        self.y = self.y.saturating_add(1);
    }

    /// Text word-wrapped to the area's width, every line in one style.
    pub fn wrapped(&mut self, frame: &mut Frame<'_>, text: &str, style: Style) {
        for line in wrap(text, usize::from(self.area.width.max(1))) {
            self.line(frame, Line::from(Span::styled(line, style)));
        }
    }

    /// A row of buttons, wrapping as needed; where each landed.
    pub fn buttons(
        &mut self,
        frame: &mut Frame<'_>,
        buttons: &[Button],
        focus: Option<usize>,
    ) -> Vec<Option<Rect>> {
        let area = Rect::new(self.area.x, self.y, self.area.width, self.remaining());
        let rects = render_buttons(frame, area, buttons, focus);
        self.y = self
            .y
            .saturating_add(buttons_height(self.area.width, buttons));
        rects
    }

    /// Reserves `height` rows and returns them, clipped to the area.
    pub fn take(&mut self, height: u16) -> Rect {
        let rect = Rect::new(
            self.area.x,
            self.y.min(self.bottom()),
            self.area.width,
            height.min(self.remaining()),
        );
        self.y = self.y.saturating_add(height);
        rect
    }
}

/// How many lines `text` wraps to at `width`.
pub fn wrapped_height(text: &str, width: u16) -> u16 {
    u16::try_from(wrap(text, usize::from(width.max(1))).len()).unwrap_or(u16::MAX)
}

/// The inside of a [`panel`]: its border, and one column of padding each side.
pub fn panel_inner(area: Rect) -> Rect {
    Rect {
        x: area.x.saturating_add(2),
        y: area.y.saturating_add(1),
        width: area.width.saturating_sub(4),
        height: area.height.saturating_sub(2),
    }
}

/// A spinner and its label, one line.
pub fn spinner_line(tick: usize, label: &str, color: ratatui::style::Color) -> Line<'static> {
    Line::from(Span::styled(
        format!("{} {label}", spinner_frame(tick)),
        Style::default().fg(color),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_marks_the_cut_and_leaves_short_text_alone() {
        assert_eq!(clip("hello", 10), "hello");
        assert_eq!(clip("hello world", 8), "hello w…");
        assert_eq!(clip("hello", 5), "hello");
        // Counted in characters, not bytes: a multi-byte name must not panic.
        assert_eq!(clip("äöüßé", 3), "äö…");
    }

    #[test]
    fn short_path_uses_a_tilde_and_keeps_the_tail() {
        let home = std::env::var("HOME").unwrap_or_default();
        if !home.is_empty() {
            assert_eq!(short_path(&format!("{home}/work/p"), 60), "~/work/p");
        }
        assert_eq!(
            short_path("/a/very/long/path/to/a/project", 10),
            "…a/project"
        );
        assert_eq!(short_path("/short", 10), "/short");
    }

    #[test]
    fn buttons_are_laid_out_left_to_right_with_a_column_between() {
        let buttons = [Button::new("ab", true), Button::new("cde", false)];
        let rects = button_rects(Rect::new(0, 0, 40, 3), &buttons);
        let first = rects[0].expect("first fits");
        let second = rects[1].expect("second fits");
        assert_eq!(first.x, 0);
        assert_eq!(first.width, 8);
        assert_eq!(second.x, 9);
        assert_eq!(second.width, 9);
    }

    #[test]
    fn a_button_that_would_overflow_wraps_or_is_left_undrawn() {
        let buttons = [Button::new("abcdefghij", true), Button::new("x", false)];
        // Room below: the second wraps onto its own line.
        let rects = button_rects(Rect::new(0, 0, 17, 6), &buttons);
        assert_eq!(rects[1], Some(Rect::new(0, 3, 7, 3)));
        assert_eq!(buttons_height(17, &buttons), 6);
        // No room below: it is not drawn at all.
        let rects = button_rects(Rect::new(0, 0, 17, 3), &buttons);
        assert!(rects[0].is_some());
        assert!(rects[1].is_none());
    }

    #[test]
    fn the_spinner_cycles() {
        assert_eq!(spinner_frame(0), "⠋");
        assert_eq!(spinner_frame(10), "⠋");
        assert_ne!(spinner_frame(1), spinner_frame(0));
    }

    #[test]
    fn the_stepper_ticks_off_what_is_done() {
        let line = stepper_line(1, &["Set up", "Ground rules", "First change"]).to_string();
        assert!(line.starts_with("✓ Set up"), "{line}");
        assert!(line.contains("2. Ground rules"), "{line}");
        assert!(line.ends_with("3. First change"), "{line}");
    }
}
