//! Drawing: pure functions from `&App` to a frame.
//!
//! Nothing here changes the app. What it returns is where the clickable
//! things landed, which the event loop hands back to the app for the next
//! click — the only thing a mouse needs that the model cannot know.

use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;

use super::app::{change_warnings, App, Hits, PromptStep, Screen, Target};
use super::document::render_document;
use super::foundation::render_foundation;
use super::guide::{first_change_lines, help_lines};
use super::home::render_home;
use super::jobs::{render_job_pane, summarize_jobs};
use super::review::render_review;
use super::theme;
use super::vision::render_vision;
use super::widgets::{
    buttons_height, clip, dim, panel, panel_inner, render_buttons, render_key_bar, short_path,
    spinner_line, stepper_line, wrapped_height, Button, Flow,
};
use crate::core::guide::{setup_steps, ProjectStage};
use crate::core::pipeline::{ChangePipeline, StageState};
use crate::core::roadmap::SliceStatus;
use crate::render::requirement::wrap;

/// The changes list is this wide, as it was in the TypeScript.
const CHANGES_WIDTH: u16 = 34;

/// Draws the whole frame, and reports where the clickable things went.
pub fn render(app: &App, frame: &mut Frame<'_>) -> Hits {
    let area = frame.area();
    let mut hits = Hits::new();
    frame.render_widget(Block::default().style(Style::default().bg(theme::BG)), area);

    if app.screen == Screen::Home && !app.jobs_open {
        render_home(frame, area, app, &mut hits);
        return hits;
    }

    let mut flow = Flow::new(area);
    render_header(frame, flow.take(1), app);
    // Setup steps until there is a change — never over a review, which has
    // its own sense of where you are.
    if let Some(step) = app.step().filter(|_| app.screen != Screen::Review) {
        let steps = setup_steps(app.greenfield);
        let row = flow.take(1);
        frame.render_widget(Paragraph::new(stepper_line(step, &steps)), inset(row, 1));
    }
    let body = Rect::new(area.x, flow.y, area.width, flow.remaining());

    if app.jobs_open {
        frame.render_widget(panel(Some("Jobs"), true), body);
        render_job_pane(frame, panel_inner(body), app, &mut hits);
        return hits;
    }
    match app.screen {
        Screen::Review => render_review(frame, body, app),
        Screen::Document => render_document(frame, body, app, &mut hits),
        Screen::Foundation => render_foundation(frame, body, app, &mut hits),
        Screen::Vision => render_vision(frame, body, app, &mut hits),
        Screen::Home | Screen::Overview => render_overview(frame, body, app, &mut hits),
    }
    hits
}

fn inset(area: Rect, by: u16) -> Rect {
    Rect {
        x: area.x.saturating_add(by),
        width: area.width.saturating_sub(by * 2),
        ..area
    }
}

/// `spec-tacular  ~/project › change › specs          jobs: 1 running`.
fn render_header(frame: &mut Frame<'_>, area: Rect, app: &App) {
    let area = inset(area, 1);
    let crumb = match app.screen {
        Screen::Review => app
            .review
            .as_ref()
            .map(|r| format!(" › {} › specs", r.session.change)),
        Screen::Document => app
            .doc
            .as_ref()
            .map(|d| format!(" › {} › {}", d.change, d.artifact)),
        Screen::Foundation => Some(" › ground rules".to_owned()),
        Screen::Vision => Some(" › vision".to_owned()),
        Screen::Home | Screen::Overview => None,
    }
    .unwrap_or_default();
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                "spec-tacular",
                Style::default()
                    .fg(theme::ACCENT)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!("  {}{crumb}", short_path(&app.root, 50)),
                Style::default().fg(theme::DIM),
            ),
        ])),
        area,
    );
    let jobs = summarize_jobs(&app.jobs);
    if !jobs.is_empty() {
        frame.render_widget(
            Paragraph::new(dim(format!("jobs: {jobs}")))
                .alignment(ratatui::layout::Alignment::Right),
            area,
        );
    }
}

fn render_overview(frame: &mut Frame<'_>, area: Rect, app: &App, hits: &mut Hits) {
    // Bottom up: the key bar, then the prompt, then whatever is left.
    let keys = app.overview_keys();
    let bar_height = 1 + u16::from(app.notice.is_some());
    let bar = Rect::new(
        area.x,
        area.y + area.height.saturating_sub(bar_height),
        area.width,
        bar_height.min(area.height),
    );
    render_key_bar(frame, inset(bar, 1), &keys, app.notice.as_deref());

    let mut rest = Rect {
        height: area.height.saturating_sub(bar_height),
        ..area
    };
    if app.prompt.is_some() {
        let height = prompt_height(app, rest.width).min(rest.height);
        let prompt = Rect::new(rest.x, rest.y + rest.height - height, rest.width, height);
        render_prompt(frame, prompt, app);
        rest.height -= height;
    }

    if app.help {
        frame.render_widget(panel(Some("Help"), true), rest);
        let inner = panel_inner(rest);
        // `padding: 1` inside the panel's own.
        let inner = Rect {
            x: inner.x + 1,
            y: inner.y + 1,
            width: inner.width.saturating_sub(2),
            height: inner.height.saturating_sub(2),
        };
        frame.render_widget(Paragraph::new(help_lines()), inner);
        return;
    }

    if let ProjectStage::Foundation { answered, total } = app.stage {
        let text = format!(
            "Ground rules: {answered} of {total} answered. f continues them — no change can \
             start until every question has an answer."
        );
        let height = (wrapped_height(&text, rest.width.saturating_sub(4)) + 2).min(rest.height);
        let banner = Rect { height, ..rest };
        frame.render_widget(panel(Some("Ground rules"), false), banner);
        let mut flow = Flow::new(panel_inner(banner));
        flow.wrapped(frame, &text, Style::default().fg(theme::WARN));
        rest.y += height;
        rest.height -= height;
    }

    let list_width = CHANGES_WIDTH.min(rest.width);
    let list = Rect {
        width: list_width,
        ..rest
    };
    let detail = Rect {
        x: rest.x + list_width,
        width: rest.width - list_width,
        ..rest
    };
    render_changes(frame, list, app, hits);
    match app.selected() {
        Some(pipeline) => render_change(frame, detail, app, pipeline, hits),
        None => render_getting_started(frame, detail, app),
    }
}

/// The left panel: every change, the roadmap, and "+ New change".
fn render_changes(frame: &mut Frame<'_>, area: Rect, app: &App, hits: &mut Hits) {
    frame.render_widget(
        panel(Some(&format!("Changes · {}", app.pipelines.len())), false),
        area,
    );
    let inner = panel_inner(area);
    let button = Button::new("+ New change", app.pipelines.is_empty());
    let button_room = if app.foundation_settled() {
        buttons_height(inner.width, std::slice::from_ref(&button))
    } else {
        0
    };
    let mut flow = Flow::new(Rect {
        height: inner.height.saturating_sub(button_room),
        ..inner
    });

    if app.pipelines.is_empty() {
        flow.line(frame, dim("none yet"));
    }
    // Scrolled just enough to keep the selection in view.
    let visible = usize::from(flow.remaining());
    let skip = (app.index + 1).saturating_sub(visible.max(1));
    for (i, pipeline) in app.pipelines.iter().enumerate().skip(skip) {
        if flow.remaining() == 0 {
            break;
        }
        let y = flow.y;
        flow.line(frame, change_row(pipeline, i == app.index, inner.width));
        hits.push((Rect::new(inner.x, y, inner.width, 1), Target::ChangeRow(i)));
    }

    // The roadmap, when the project started from a vision.
    if let Some(roadmap) = app.roadmap.as_ref().filter(|r| !r.slices.is_empty()) {
        flow.blank();
        flow.line(
            frame,
            Line::from(Span::styled("Roadmap", Style::default().fg(theme::ACCENT2))),
        );
        for slice in &roadmap.slices {
            let color = match slice.status {
                SliceStatus::Active => theme::ACCENT,
                SliceStatus::Done => theme::OK,
                SliceStatus::Planned => theme::DIM,
            };
            flow.line(
                frame,
                Line::from(Span::styled(
                    clip(&format!("{} {}", slice.status.mark(), slice.id), 30),
                    Style::default().fg(color),
                )),
            );
        }
    }

    if button_room > 0 {
        let at = Rect::new(
            inner.x,
            inner.y + inner.height - button_room,
            inner.width,
            button_room,
        );
        if let Some(Some(rect)) = render_buttons(frame, at, &[button], None).first() {
            hits.push((*rect, Target::NewChange));
        }
    }
}

/// `▸ add-login                 ! 2/5`.
fn change_row(pipeline: &ChangePipeline, selected: bool, width: u16) -> Line<'static> {
    let specs = pipeline.stages.iter().find_map(|s| s.review);
    let warn = specs.is_some_and(|r| r.drifted > 0)
        || !crate::core::gate::stale_artifacts(pipeline).is_empty()
        || !pipeline.gaps.is_empty();
    let count = match specs {
        Some(r) => format!("{}/{}", r.accepted, r.total),
        None => format!("{}/{}", pipeline.written, pipeline.total),
    };
    let right = count.chars().count() + if warn { 2 } else { 0 };
    let room = usize::from(width).saturating_sub(right + 1);
    let name = clip(
        &format!("{} {}", if selected { "▸" } else { " " }, pipeline.name),
        room,
    );
    let pad = usize::from(width).saturating_sub(name.chars().count() + right);
    let bg = if selected {
        theme::HIGHLIGHT
    } else {
        theme::PANEL
    };
    let mut spans = vec![Span::styled(
        format!("{name}{}", " ".repeat(pad)),
        Style::default()
            .fg(if selected { theme::ACCENT } else { theme::TEXT })
            .bg(bg),
    )];
    if warn {
        spans.push(Span::styled("! ", Style::default().fg(theme::WARN).bg(bg)));
    }
    spans.push(Span::styled(
        count,
        Style::default()
            .fg(if specs.is_some_and(|r| r.complete) {
                theme::OK
            } else {
                theme::DIM
            })
            .bg(bg),
    ));
    Line::from(spans)
}

fn stage_color(state: StageState) -> ratatui::style::Color {
    match state {
        StageState::Accepted => theme::OK,
        StageState::Written => theme::TEXT,
        StageState::Ready => theme::ACCENT,
        StageState::Blocked => theme::DIM,
    }
}

fn stage_mark(state: StageState) -> &'static str {
    match state {
        StageState::Accepted => "✓",
        StageState::Written => "●",
        StageState::Ready => "◉",
        StageState::Blocked => "○",
    }
}

/// `◉ proposal ── ○ specs ── ○ design ── ○ tasks ── ○ apply`.
pub fn pipeline_bar(pipeline: &ChangePipeline) -> Line<'static> {
    let stages: Vec<_> = pipeline.all_stages().collect();
    let mut spans = Vec::new();
    for (i, stage) in stages.iter().enumerate() {
        spans.push(Span::styled(
            format!("{} {}", stage_mark(stage.state), stage.id),
            Style::default().fg(stage_color(stage.state)),
        ));
        if i + 1 < stages.len() {
            spans.push(Span::styled(" ── ", Style::default().fg(theme::BORDER)));
        }
    }
    Line::from(spans)
}

/// The right panel: the selected change's pipeline, warnings, and either the
/// agent working on it or its next step.
fn render_change(
    frame: &mut Frame<'_>,
    area: Rect,
    app: &App,
    pipeline: &ChangePipeline,
    hits: &mut Hits,
) {
    frame.render_widget(panel(Some(&pipeline.name), true), area);
    let mut flow = Flow::new(panel_inner(area));
    flow.blank();
    flow.line(frame, pipeline_bar(pipeline));
    flow.blank();
    for warning in change_warnings(pipeline) {
        flow.wrapped(
            frame,
            &format!("! {warning}"),
            Style::default().fg(theme::WARN),
        );
    }

    // An agent at work: what it is doing, live.
    if let Some(job) = app.running() {
        let driver = if job.driver == "claude" {
            "Claude Code"
        } else {
            job.driver.as_str()
        };
        flow.blank();
        flow.line(
            frame,
            spinner_line(
                app.tick,
                &format!(
                    "{driver} is drafting the {} · {}",
                    job.artifact,
                    app.elapsed()
                ),
                theme::ACCENT2,
            ),
        );
        flow.blank();
        let lines: Vec<String> = if app.running_lines.is_empty() {
            vec!["starting…".to_owned()]
        } else {
            app.running_lines
                .iter()
                .map(|l| clip(&l.split_whitespace().collect::<Vec<_>>().join(" "), 90))
                .collect()
        };
        let height = u16::try_from(lines.len()).unwrap_or(u16::MAX);
        let block = flow.take(height);
        frame.render_widget(
            Paragraph::new(
                lines
                    .into_iter()
                    .map(|l| Line::from(Span::styled(l, Style::default().fg(theme::DIM))))
                    .collect::<Vec<_>>(),
            )
            .block(
                Block::default()
                    .borders(Borders::LEFT)
                    .border_style(Style::default().fg(theme::BORDER))
                    .padding(ratatui::widgets::Padding::left(1)),
            ),
            block,
        );
        flow.blank();
        flow.wrapped(
            frame,
            "It opens here for you to read when it is done. Keep working meanwhile.",
            Style::default().fg(theme::TEXT),
        );
        flow.blank();
        let rects = flow.buttons(
            frame,
            &[Button::new("Watch the full log  ctrl+j", false)],
            None,
        );
        if let Some(Some(rect)) = rects.first() {
            hits.push((*rect, Target::WatchLog));
        }
        return;
    }

    if let Some(next) = app.next() {
        flow.blank();
        flow.line(
            frame,
            Line::from(Span::styled(
                "Next",
                Style::default()
                    .fg(theme::ACCENT2)
                    .add_modifier(Modifier::BOLD),
            )),
        );
        flow.wrapped(frame, &next.text, Style::default().fg(theme::TEXT));
        flow.blank();
        let actions = app.action_buttons();
        let buttons: Vec<Button> = actions
            .iter()
            .enumerate()
            .map(|(i, b)| Button::new(format!("{}  {}", b.label, b.key), i == 0))
            .collect();
        let rects = flow.buttons(frame, &buttons, Some(app.focused_action()));
        for (i, rect) in rects.into_iter().enumerate() {
            if let Some(rect) = rect {
                hits.push((rect, Target::Action(i)));
            }
        }
    }
}

/// The right panel when there is no change: how to start one.
fn render_getting_started(frame: &mut Frame<'_>, area: Rect, app: &App) {
    frame.render_widget(panel(Some("Getting started"), false), area);
    let inner = panel_inner(area);
    // A project at the vision step is also shown the first-change guide:
    // `n` still starts a single change there, as "Not a new project" does.
    if matches!(app.stage, ProjectStage::NoChanges | ProjectStage::Vision) {
        let padded = Rect {
            x: inner.x + 1,
            y: inner.y + 1,
            width: inner.width.saturating_sub(2),
            height: inner.height.saturating_sub(2),
        };
        frame.render_widget(Paragraph::new(first_change_lines()), padded);
    } else {
        frame.render_widget(
            Paragraph::new(dim("Settle the ground rules first — f.")),
            inner,
        );
    }
}

/// The lines of the new-change prompt's input box.
fn prompt_input_lines(draft: &str) -> Vec<String> {
    wrap(&format!("{draft}▏"), 100)
        .into_iter()
        .enumerate()
        .map(|(i, line)| format!("{}{line}", if i == 0 { "› " } else { "  " }))
        .collect()
}

/// The text above the input: what is being asked.
fn prompt_text(app: &App, width: u16) -> Vec<Line<'static>> {
    let Some(prompt) = &app.prompt else {
        return Vec::new();
    };
    let width = usize::from(width.max(1));
    let styled = |text: &str, color| -> Vec<Line<'static>> {
        wrap(text, width)
            .into_iter()
            .map(|l| Line::from(Span::styled(l, Style::default().fg(color))))
            .collect()
    };
    match prompt.step {
        PromptStep::Describe => {
            let mut lines = styled(
                "What do you want to change, and why? A sentence or two — the agent drafting \
                 the proposal starts from this.",
                theme::TEXT,
            );
            lines.extend(styled(
                "e.g. \"Let users sign in with email and password so their data follows them \
                 across devices\"",
                theme::DIM,
            ));
            lines
        }
        PromptStep::Name => {
            let mut lines = vec![dim(clip(&format!("“{}”", prompt.description), 110))];
            lines.extend(styled(
                "A name for it — proposed from your description; adjust it if you like.",
                theme::TEXT,
            ));
            lines
        }
    }
}

fn prompt_footer(app: &App) -> Option<Line<'static>> {
    let prompt = app.prompt.as_ref()?;
    if prompt.step != PromptStep::Name {
        return None;
    }
    if prompt.naming {
        return Some(spinner_line(
            app.tick,
            "✦ proposing a better name…",
            theme::ACCENT2,
        ));
    }
    (prompt.names.len() > 1).then(|| {
        dim(format!(
            "suggestions: {}   (tab cycles)",
            prompt.names.join(" · ")
        ))
    })
}

fn prompt_height(app: &App, width: u16) -> u16 {
    let Some(prompt) = &app.prompt else {
        return 0;
    };
    let inner = width.saturating_sub(4);
    let text = u16::try_from(prompt_text(app, inner).len()).unwrap_or(0);
    let input = u16::try_from(prompt_input_lines(&prompt.draft).len()).unwrap_or(1) + 2;
    let footer = u16::from(prompt_footer(app).is_some());
    2 + text + input + footer
}

fn render_prompt(frame: &mut Frame<'_>, area: Rect, app: &App) {
    let Some(prompt) = &app.prompt else {
        return;
    };
    let title = match prompt.step {
        PromptStep::Describe => "New change · 1 of 2 · what",
        PromptStep::Name => "New change · 2 of 2 · name",
    };
    frame.render_widget(panel(Some(title), true), area);
    let inner = panel_inner(area);
    let mut flow = Flow::new(inner);
    for line in prompt_text(app, inner.width) {
        flow.line(frame, line);
    }
    let input = prompt_input_lines(&prompt.draft);
    let height = u16::try_from(input.len()).unwrap_or(1) + 2;
    let rect = flow.take(height);
    frame.render_widget(
        Paragraph::new(
            input
                .into_iter()
                .map(|l| Line::from(Span::styled(l, Style::default().fg(theme::TEXT))))
                .collect::<Vec<_>>(),
        )
        .block(
            Block::bordered()
                .border_type(ratatui::widgets::BorderType::Rounded)
                .border_style(Style::default().fg(theme::ACCENT))
                .padding(ratatui::widgets::Padding::left(1)),
        ),
        rect,
    );
    if let Some(footer) = prompt_footer(app) {
        flow.line(frame, footer);
    }
}
