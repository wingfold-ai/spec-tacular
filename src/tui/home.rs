//! The start screen: the logo, where the project stands, and one obvious
//! button for the next step.
//!
//! Shown on every launch, the way opencode opens on its own logo: it is the
//! one screen that answers "what is this, and what do I do now" before any
//! detail appears. Enter always takes the highlighted — next — step. Its keys
//! are handled in [`super::app`]; this draws it.

use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use super::app::{App, Hits, HomeAction, Target};
use super::logo::{face_for, logo_lines};
use super::theme;
use super::widgets::{
    button_rects, render_buttons, short_path, spinner_line, Button, BUTTON_HEIGHT,
};

pub const TAGLINE: &str = "spec-driven development — every requirement reviewed before it is built";
const HINT: &str = "←/→ choose · enter select · q quit · or click";

/// The start screen's buttons: the actions, then Quit. The first is primary
/// and wears the ▶.
pub fn home_buttons(actions: &[HomeAction]) -> Vec<Button> {
    let mut buttons: Vec<Button> = actions
        .iter()
        .enumerate()
        .map(|(i, action)| {
            if i == 0 {
                Button::new(format!("▶ {}", action.label()), true)
            } else {
                Button::new(action.label(), false)
            }
        })
        .collect();
    buttons.push(Button::new("Quit", false));
    buttons
}

/// One row of the centred column: a line of text, or the button row.
enum Row {
    Text(Line<'static>),
    Buttons,
}

pub fn render_home(frame: &mut Frame<'_>, area: Rect, app: &App, hits: &mut Hits) {
    let face = face_for(area.width);
    let mut rows: Vec<Row> = logo_lines(face, app.tick)
        .into_iter()
        .map(Row::Text)
        .collect();
    let text =
        |s: String, color| Row::Text(Line::from(Span::styled(s, Style::default().fg(color))));
    let blank = || Row::Text(Line::default());

    rows.extend([blank(), blank()]);
    rows.push(text(TAGLINE.to_owned(), theme::TEXT));
    rows.push(blank());
    rows.push(text(app.home_status(), theme::ACCENT2));
    rows.push(blank());
    rows.push(Row::Buttons);
    if let Some(error) = &app.home.error {
        rows.push(blank());
        rows.push(text(error.clone(), theme::ERR));
    }
    if let Some(notice) = &app.notice {
        rows.push(blank());
        rows.push(text(notice.clone(), theme::WARN));
    }
    rows.push(blank());
    rows.push(text(short_path(&app.root, 80), theme::DIM));
    rows.push(text(HINT.to_owned(), theme::DIM));

    let height: u16 = rows
        .iter()
        .map(|row| match row {
            Row::Text(_) => 1,
            Row::Buttons => BUTTON_HEIGHT,
        })
        .sum();
    let mut y = area.y + area.height.saturating_sub(height) / 2;
    let bottom = area.y.saturating_add(area.height);

    for row in rows {
        match row {
            Row::Text(line) => {
                if y < bottom {
                    let width = u16::try_from(line.width())
                        .unwrap_or(u16::MAX)
                        .min(area.width);
                    let x = area.x + (area.width - width) / 2;
                    frame.render_widget(Paragraph::new(line), Rect::new(x, y, width, 1));
                }
                y = y.saturating_add(1);
            }
            Row::Buttons => {
                let band = Rect::new(
                    area.x,
                    y,
                    area.width,
                    BUTTON_HEIGHT.min(bottom.saturating_sub(y)),
                );
                if let Some(busy) = &app.home.busy {
                    // The spinner stands where the buttons will be, one row
                    // down so the column does not jump when they arrive.
                    let line = spinner_line(app.tick, busy, theme::ACCENT2);
                    let width = u16::try_from(line.width())
                        .unwrap_or(u16::MAX)
                        .min(area.width);
                    if band.height > 1 {
                        frame.render_widget(
                            Paragraph::new(line),
                            Rect::new(area.x + (area.width - width) / 2, y + 1, width, 1),
                        );
                    }
                } else {
                    let buttons = home_buttons(&app.home_actions());
                    let focus = app.home.focus.min(buttons.len() - 1);
                    let total: u16 = buttons
                        .iter()
                        .map(|b| b.width() + 1)
                        .sum::<u16>()
                        .saturating_sub(1);
                    let x = area.x + area.width.saturating_sub(total) / 2;
                    let row = Rect::new(
                        x,
                        band.y,
                        area.width.saturating_sub(x - area.x),
                        band.height,
                    );
                    // Measured first, so a row too narrow to hold them all
                    // wraps from the left edge rather than from the middle.
                    let row = if button_rects(row, &buttons).iter().all(Option::is_some) {
                        row
                    } else {
                        band
                    };
                    let rects = render_buttons(frame, row, &buttons, Some(focus));
                    for (i, rect) in rects.into_iter().enumerate() {
                        if let Some(rect) = rect {
                            hits.push((rect, Target::HomeButton(i)));
                        }
                    }
                }
                y = y.saturating_add(BUTTON_HEIGHT);
            }
        }
    }
}
