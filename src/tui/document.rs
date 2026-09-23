//! The document viewer: reading what an agent drafted.
//!
//! The TypeScript `document.tsx`, and the document half of its `app.tsx`. A
//! proposal or a design is prose, not a list of requirements, so it is not
//! walked item by item — but it still has to be *read* before the next stage
//! is built on it. This shows it in full, scrollable, with the three things
//! worth doing next: move on, edit it, or have it redrafted with feedback.

use std::path::PathBuf;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Padding, Paragraph};
use ratatui::Frame;

use super::app::{spawn, AfterEditor, App, Effect, Hits, Msg, Screen, Target};
use super::input::{edit_line, is_cancel, is_enter};
use super::ports::Ports;
use super::theme;
use super::widgets::{buttons_height, panel, panel_inner, render_buttons, render_key_bar, Button};
use crate::core::guide::NextAction;
use crate::core::pipeline::StageState;
use crate::render::requirement::wrap;

/// An artifact open for reading.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Document {
    pub change: String,
    pub artifact: String,
    pub file: PathBuf,
    pub content: String,
    /// The first line shown.
    pub top: usize,
    /// The focused button.
    pub focus: usize,
    /// The feedback being typed for a redraft, while the line is open.
    pub feedback: Option<String>,
}

/// What a document's buttons do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocAction {
    /// "✓ Looks good — draft the …": close it and draft the next artifact.
    DraftNext,
    /// "✓ Looks good", when there is nothing to draft next.
    Close,
    Edit,
    Redraft,
    Back,
}

/// One of the viewer's buttons.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocButton {
    pub label: String,
    pub key: char,
    pub action: DocAction,
}

/// One rendered line of the document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocLine {
    pub text: String,
    pub fg: Color,
    pub bold: bool,
}

impl DocLine {
    fn new(text: impl Into<String>, fg: Color) -> Self {
        Self {
            text: text.into(),
            fg,
            bold: false,
        }
    }
}

/// `/^\s*<!--.*-->\s*$/`: a comment alone on its line.
fn is_comment(line: &str) -> bool {
    let t = line.trim();
    t.starts_with("<!--") && t.ends_with("-->") && t.len() >= 7
}

/// `/^(#{1,6})\s+(.*)$/`: the level and the text.
fn heading(line: &str) -> Option<(usize, &str)> {
    let level = line.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let rest = &line[level..];
    let text = rest.trim_start();
    (rest.starts_with(char::is_whitespace) && text.len() < rest.len())
        .then_some(text)
        .map(|t| (level, t))
}

/// `/^(\s*)([-*]|\d+\.)\s+(.*)$/`: the indent, the mark and the text.
fn bullet(line: &str) -> Option<(usize, String, &str)> {
    let body = line.trim_start();
    let indent = line.len() - body.len();
    let (mark, rest) = if let Some(rest) = body.strip_prefix(['-', '*']) {
        ("•".to_owned(), rest)
    } else {
        let digits = body.chars().take_while(char::is_ascii_digit).count();
        let rest = body[digits..].strip_prefix('.').filter(|_| digits > 0)?;
        (body[..=digits].to_owned(), rest)
    };
    let text = rest.trim_start();
    (rest.starts_with(char::is_whitespace) && text.len() < rest.len())
        .then_some((indent, mark, text))
}

/// Just enough Markdown to read comfortably: headings, lists, code fences,
/// and the template's comments left out.
pub fn markdown_lines(content: &str, width: usize) -> Vec<DocLine> {
    let mut out: Vec<DocLine> = Vec::new();
    let mut fence = false;
    let content = content.replace("\r\n", "\n").replace('\r', "\n");
    for raw in content.split('\n') {
        if raw.trim_start().starts_with("```") {
            fence = !fence;
            out.push(DocLine::new(raw, theme::DIM));
            continue;
        }
        if fence {
            out.push(DocLine::new(raw, theme::ACCENT2));
            continue;
        }
        // Template comments an agent left in are instructions, not content.
        if is_comment(raw) {
            continue;
        }
        if let Some((level, text)) = heading(raw) {
            if out.last().is_some_and(|l| !l.text.is_empty()) {
                out.push(DocLine::new("", theme::TEXT));
            }
            out.push(DocLine {
                text: text.to_owned(),
                fg: if level <= 2 {
                    theme::ACCENT
                } else {
                    theme::ACCENT2
                },
                bold: true,
            });
            continue;
        }
        if let Some((indent, mark, text)) = bullet(raw) {
            let lines = wrap(text, width.saturating_sub(indent + 4).max(1));
            for (i, line) in lines.into_iter().enumerate() {
                let lead = if i == 0 {
                    format!("{mark} ")
                } else {
                    "  ".to_owned()
                };
                out.push(DocLine::new(
                    format!("{}{lead}{line}", " ".repeat(indent)),
                    theme::TEXT,
                ));
            }
            continue;
        }
        for line in wrap(raw, width.max(1)) {
            out.push(DocLine::new(line, theme::TEXT));
        }
    }
    out
}

impl App {
    /// Prose artifacts written for the selected change — what can be read.
    /// Specs are reviewed, not read, and span a file per capability.
    pub fn readable(&self) -> Vec<String> {
        self.selected()
            .map(|p| {
                p.stages
                    .iter()
                    .filter(|s| {
                        !matches!(s.state, StageState::Ready | StageState::Blocked)
                            && s.review.is_none()
                    })
                    .map(|s| s.id.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Reads an artifact off the loop's thread, to open it when it arrives.
    /// `just_drafted` is the job poll opening a fresh draft by itself: if it
    /// cannot be read, that is not worth a notice.
    pub(super) fn open_doc(
        &self,
        ports: &dyn Ports,
        change: &str,
        artifact: &str,
        just_drafted: bool,
    ) -> Effect {
        let (c, a) = (change.to_owned(), artifact.to_owned());
        spawn(ports.read_artifact(change, artifact), move |result| {
            Msg::DocRead {
                change: c,
                artifact: a,
                result,
                just_drafted,
            }
        })
    }

    pub(super) fn doc_read(
        &mut self,
        change: String,
        artifact: String,
        result: Result<(PathBuf, String), String>,
        just_drafted: bool,
    ) {
        match result {
            Ok((file, content)) => {
                // A fresh draft opens only for someone still idle on the
                // overview; one asked for opens wherever it was asked.
                if just_drafted && !self.idle() {
                    return;
                }
                if !matches!(self.screen, Screen::Overview | Screen::Document) {
                    return;
                }
                let same = self
                    .doc
                    .as_ref()
                    .is_some_and(|d| d.change == change && d.artifact == artifact);
                let top = if same {
                    self.doc.as_ref().map_or(0, |d| d.top)
                } else {
                    0
                };
                self.doc = Some(Document {
                    change,
                    artifact,
                    file,
                    content,
                    top,
                    focus: 0,
                    feedback: None,
                });
                self.screen = Screen::Document;
            }
            Err(reason) => {
                if !just_drafted {
                    self.notice = Some(reason);
                }
            }
        }
    }

    /// On the overview with nothing else going on — the only time a draft
    /// may open by itself.
    pub(super) fn idle(&self) -> bool {
        self.screen == Screen::Overview
            && self.review.is_none()
            && !self.jobs_open
            && self.prompt.is_none()
    }

    /// `v`, "📄 Read the …": the latest prose artifact of the selected change.
    pub(super) fn read_latest(&mut self, ports: &dyn Ports) -> Vec<Effect> {
        let latest = self.readable().pop();
        match (self.selected().map(|p| p.name.clone()), latest) {
            (Some(change), Some(latest)) => vec![self.open_doc(ports, &change, &latest, false)],
            _ => Vec::new(),
        }
    }

    fn close_doc(&mut self) {
        self.doc = None;
        self.screen = Screen::Overview;
    }

    /// What reading a document offers: move on first, then change it.
    pub fn doc_buttons(&self) -> Vec<DocButton> {
        let Some(doc) = &self.doc else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let next = self.next().filter(|step| {
            step.actions.contains(&NextAction::Draft)
                && step.artifact.as_deref().is_some_and(|a| a != doc.artifact)
        });
        match next.and_then(|step| step.artifact) {
            Some(artifact) => out.push(DocButton {
                label: if artifact == "apply" {
                    "✓ Looks good — start implementing".to_owned()
                } else {
                    format!("✓ Looks good — draft the {artifact}")
                },
                key: 'n',
                action: DocAction::DraftNext,
            }),
            None => out.push(DocButton {
                label: "✓ Looks good".to_owned(),
                key: 'n',
                action: DocAction::Close,
            }),
        }
        out.push(DocButton {
            label: "✎ Edit it".to_owned(),
            key: 'e',
            action: DocAction::Edit,
        });
        out.push(DocButton {
            label: "↻ Redraft with feedback".to_owned(),
            key: 'f',
            action: DocAction::Redraft,
        });
        out.push(DocButton {
            label: "← Back".to_owned(),
            key: 'q',
            action: DocAction::Back,
        });
        out
    }

    /// Where the text went last frame; before any frame, a guess.
    fn doc_text_area(&self) -> Rect {
        self.hits
            .iter()
            .find(|(_, t)| *t == Target::DocText)
            .map_or(Rect::new(0, 0, 80, 20), |(r, _)| *r)
    }

    /// The document's lines at the width it is drawn at.
    fn doc_lines(&self) -> usize {
        let width = usize::from(self.doc_text_area().width);
        self.doc
            .as_ref()
            .map_or(0, |d| markdown_lines(&d.content, width).len())
    }

    fn doc_page(&self) -> usize {
        usize::from(self.doc_text_area().height).max(1)
    }

    fn scroll(&mut self, delta: isize) {
        let max = self.doc_lines().saturating_sub(self.doc_page());
        if let Some(doc) = self.doc.as_mut() {
            doc.top = doc.top.saturating_add_signed(delta).min(max);
        }
    }

    /// The wheel over the viewer: three lines a notch, as in the TypeScript.
    pub(super) fn doc_wheel(&mut self, down: bool) {
        self.scroll(if down { 3 } else { -3 });
    }

    pub(super) fn document_key(&mut self, ports: &dyn Ports, key: &KeyEvent) -> Vec<Effect> {
        let Some(doc) = self.doc.as_mut() else {
            self.screen = Screen::Overview;
            return Vec::new();
        };
        if let Some(draft) = doc.feedback.as_mut() {
            if is_cancel(key) {
                doc.feedback = None;
            } else if is_enter(key) {
                let text = draft.trim().to_owned();
                if !text.is_empty() {
                    doc.feedback = None;
                    return self.redraft(ports, &text);
                }
            } else if let Some(edited) = edit_line(draft, key) {
                *draft = edited;
            }
            return Vec::new();
        }

        if is_cancel(key) {
            self.close_doc();
            return Vec::new();
        }
        let buttons = self.doc_buttons();
        let page = isize::try_from(self.doc_page()).unwrap_or(isize::MAX);
        if key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
        {
            return Vec::new();
        }
        match key.code {
            KeyCode::Down | KeyCode::Char('j') => self.scroll(1),
            KeyCode::Up | KeyCode::Char('k') => self.scroll(-1),
            KeyCode::PageDown | KeyCode::Char(' ') => self.scroll(page - 2),
            KeyCode::PageUp => self.scroll(-(page - 2)),
            KeyCode::Char('g') => {
                if let Some(doc) = self.doc.as_mut() {
                    doc.top = 0;
                }
            }
            KeyCode::Char('G') => self.scroll(isize::MAX),
            KeyCode::Right | KeyCode::Tab => {
                if let Some(doc) = self.doc.as_mut() {
                    doc.focus = (doc.focus + 1) % buttons.len();
                }
            }
            KeyCode::Left | KeyCode::BackTab => {
                if let Some(doc) = self.doc.as_mut() {
                    doc.focus = (doc.focus + buttons.len() - 1) % buttons.len();
                }
            }
            KeyCode::Enter => {
                let focus = self.doc.as_ref().map_or(0, |d| d.focus);
                return self.press_doc(ports, focus);
            }
            KeyCode::Char(c) => {
                if let Some(i) = buttons.iter().position(|b| b.key == c) {
                    return self.press_doc(ports, i);
                }
            }
            _ => {}
        }
        Vec::new()
    }

    /// Presses the viewer's button `i`, by key, by enter or by click.
    pub(super) fn press_doc(&mut self, ports: &dyn Ports, i: usize) -> Vec<Effect> {
        let Some(button) = self.doc_buttons().into_iter().nth(i) else {
            return Vec::new();
        };
        let Some(doc) = self.doc.as_mut() else {
            return Vec::new();
        };
        doc.focus = i;
        match button.action {
            DocAction::DraftNext => {
                self.close_doc();
                self.draft_next(ports)
            }
            DocAction::Close | DocAction::Back => {
                self.close_doc();
                Vec::new()
            }
            DocAction::Edit => vec![Effect::Editor {
                file: doc.file.clone(),
                line: 1,
                then: AfterEditor::Document {
                    change: doc.change.clone(),
                    artifact: doc.artifact.clone(),
                },
            }],
            DocAction::Redraft => {
                doc.feedback = Some(String::new());
                Vec::new()
            }
        }
    }

    /// The same artifact again, with what the developer said should change.
    fn redraft(&mut self, ports: &dyn Ports, feedback: &str) -> Vec<Effect> {
        let Some(doc) = self.doc.clone() else {
            return Vec::new();
        };
        self.close_doc();
        vec![spawn(
            ports.dispatch(&doc.change, &doc.artifact, Some(feedback)),
            Msg::Dispatched,
        )]
    }

    /// Back from editing the document: read it again, and the overview too.
    pub(super) fn doc_edited(
        &mut self,
        ports: &dyn Ports,
        result: Result<(), String>,
        change: String,
        artifact: String,
    ) -> Vec<Effect> {
        if let Err(reason) = result {
            self.notice = Some(reason);
            return Vec::new();
        }
        vec![
            self.open_doc(ports, &change, &artifact, false),
            self.reload(ports, Some(change), None, None),
        ]
    }
}

/// The key bar under the viewer.
fn doc_keys(doc: &Document) -> Vec<(&'static str, &'static str)> {
    if doc.feedback.is_some() {
        vec![("enter", "redraft"), ("ctrl+c", "cancel")]
    } else {
        vec![
            ("↑↓", "scroll"),
            ("space", "page"),
            ("←→", "action"),
            ("enter", "go"),
            ("q", "back"),
        ]
    }
}

/// Draws the viewer into `area`: the text, the feedback line when open, the
/// buttons, the key bar. Records the text's rect, which is how the keys know
/// what a page is.
pub fn render_document(frame: &mut Frame<'_>, area: Rect, app: &App, hits: &mut Hits) {
    let Some(doc) = &app.doc else {
        return;
    };
    let bar_height = 1 + u16::from(app.notice.is_some());
    let bar = Rect::new(
        area.x + 1,
        area.y + area.height.saturating_sub(bar_height),
        area.width.saturating_sub(2),
        bar_height.min(area.height),
    );
    render_key_bar(frame, bar, &doc_keys(doc), app.notice.as_deref());
    let body = Rect {
        height: area.height.saturating_sub(bar_height),
        ..area
    };
    let inner = panel_inner(body);

    let buttons: Vec<Button> = app
        .doc_buttons()
        .iter()
        .enumerate()
        .map(|(i, b)| Button::new(format!("{}  {}", b.label, b.key), i == 0))
        .collect();
    let buttons_h = buttons_height(inner.width, &buttons).min(inner.height);
    let feedback_h = if doc.feedback.is_some() { 4 } else { 0 };
    let text_h = inner.height.saturating_sub(buttons_h + feedback_h);
    let text = Rect {
        height: text_h,
        ..inner
    };
    hits.push((text, Target::DocText));

    let lines = markdown_lines(&doc.content, usize::from(text.width));
    let page = usize::from(text_h);
    let top = doc.top.min(lines.len().saturating_sub(page));
    let scrolled = if lines.len() <= page {
        "all of it".to_owned()
    } else {
        let shown = (top + page) as f64 / lines.len() as f64 * 100.0;
        format!("{}% · {} lines", shown.round(), lines.len())
    };
    frame.render_widget(
        panel(
            Some(&format!("{} › {} · {scrolled}", doc.change, doc.artifact)),
            true,
        ),
        body,
    );
    let visible: Vec<Line<'static>> = lines
        .into_iter()
        .skip(top)
        .take(page)
        .map(|line| {
            let mut style = Style::default().fg(line.fg);
            if line.bold {
                style = style.add_modifier(Modifier::BOLD);
            }
            Line::from(Span::styled(line.text, style))
        })
        .collect();
    frame.render_widget(Paragraph::new(visible), text);

    let mut y = text.y + text_h;
    if let Some(draft) = &doc.feedback {
        let ask = Rect::new(inner.x, y, inner.width, 1);
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                "What should change? The agent redrafts it with this.",
                Style::default().fg(theme::WARN),
            ))),
            ask,
        );
        let input = Rect::new(inner.x, y + 1, inner.width, 3);
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                format!("› {draft}▏"),
                Style::default().fg(theme::TEXT),
            )))
            .block(
                Block::bordered()
                    .border_type(BorderType::Rounded)
                    .border_style(Style::default().fg(theme::ACCENT))
                    .padding(Padding::left(1)),
            ),
            input,
        );
        y += feedback_h;
    }

    let focus = doc.feedback.is_none().then_some(doc.focus);
    let rects = render_buttons(
        frame,
        Rect::new(inner.x, y, inner.width, buttons_h),
        &buttons,
        focus,
    );
    for (i, rect) in rects.into_iter().enumerate() {
        if let Some(rect) = rect {
            hits.push((rect, Target::DocButton(i)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(content: &str) -> Vec<String> {
        markdown_lines(content, 60)
            .into_iter()
            .map(|l| l.text)
            .collect()
    }

    #[test]
    fn headings_lose_their_hashes_and_get_room_above() {
        let lines = markdown_lines("intro\n## Why\nBecause.", 60);
        assert_eq!(lines[1].text, "");
        assert_eq!(lines[2].text, "Why");
        assert!(lines[2].bold);
        assert_eq!(lines[2].fg, theme::ACCENT);
        let deep = markdown_lines("### Detail", 60);
        assert_eq!(deep[0].fg, theme::ACCENT2);
        // `#tag` is not a heading.
        assert_eq!(texts("#tag"), ["#tag"]);
    }

    #[test]
    fn bullets_become_dots_and_numbers_stay() {
        assert_eq!(
            texts("- Add booking\n* Cancel\n  - nested\n3. third"),
            ["• Add booking", "• Cancel", "  • nested", "3. third"]
        );
    }

    #[test]
    fn a_long_bullet_wraps_under_its_text() {
        let lines = markdown_lines("- aaaa bbbb cccc dddd", 14);
        let texts: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts, ["• aaaa bbbb", "  cccc dddd"]);
    }

    #[test]
    fn template_comments_are_dropped_and_fences_are_kept_verbatim() {
        assert_eq!(
            texts("<!-- Describe the change -->\nText\n```\n- not a bullet\n```"),
            ["Text", "```", "- not a bullet", "```"]
        );
        let lines = markdown_lines("```\ncode\n```", 60);
        assert_eq!(lines[0].fg, theme::DIM);
        assert_eq!(lines[1].fg, theme::ACCENT2);
    }
}
