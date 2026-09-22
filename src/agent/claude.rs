//! Claude Code driver.
//!
//! `claude -p` is the non-interactive mode. `stream-json` is used rather than
//! plain text because it arrives incrementally — a job pane that only fills in
//! once the agent finishes is not a job pane.

use serde::Deserialize;

use super::driver::{
    AgentCommand, AgentDriver, AgentRequest, StructuredDriver, StructuredMode, StructuredRequest,
};

/// One event of `--output-format stream-json`. Everything is optional: the
/// stream carries several shapes, and a field this build has not heard of is
/// not a reason to stop rendering the rest.
#[derive(Debug, Default, Deserialize)]
struct StreamEvent {
    #[serde(default)]
    r#type: Option<String>,
    #[serde(default)]
    message: Option<StreamMessage>,
    #[serde(default)]
    result: Option<String>,
    #[serde(default)]
    is_error: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct StreamMessage {
    #[serde(default)]
    content: Vec<StreamPart>,
}

#[derive(Debug, Default, Deserialize)]
struct StreamPart {
    #[serde(default)]
    r#type: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

/// The answer to a `--output-format json` request.
#[derive(Debug, Default, Deserialize)]
struct StructuredResult {
    #[serde(default)]
    is_error: Option<bool>,
    #[serde(default)]
    result: Option<String>,
    #[serde(default)]
    structured_output: Option<serde_json::Value>,
}

/// Extra flags from the environment, split on whitespace.
fn extra_args() -> Vec<String> {
    std::env::var("SPECTACULAR_CLAUDE_ARGS")
        .unwrap_or_default()
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

/// The model an advisor request runs on, by mode.
fn model_for(mode: StructuredMode) -> String {
    match mode {
        StructuredMode::Quick => {
            std::env::var("SPECTACULAR_QUICK_MODEL").unwrap_or_else(|_| "haiku".to_owned())
        }
        _ => std::env::var("SPECTACULAR_ADVISOR_MODEL").unwrap_or_else(|_| "sonnet".to_owned()),
    }
}

/// The Claude Code driver.
pub struct ClaudeDriver;

/// Its structured half, kept separate so `structured()` can hand out a
/// reference to something that is not the driver itself.
struct ClaudeStructured;

impl AgentDriver for ClaudeDriver {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn label(&self) -> &'static str {
        "Claude Code"
    }

    fn build(&self, request: &AgentRequest<'_>) -> AgentCommand {
        let mut args = vec![
            "-p".to_owned(),
            request.prompt.to_owned(),
            "--output-format".to_owned(),
            "stream-json".to_owned(),
            // stream-json requires --verbose; without it the CLI refuses to
            // start, which would look like a driver bug rather than a missing
            // flag.
            "--verbose".to_owned(),
            // Headless, nobody is there to approve a tool call, so each one is
            // denied — and the agent "succeeds" having printed its artifact
            // instead of writing it. Editing files in the project is the job;
            // OpenSpec's read-only commands are how it looks at existing specs.
            "--permission-mode".to_owned(),
            "acceptEdits".to_owned(),
            "--allowedTools".to_owned(),
            "Bash(openspec list:*)".to_owned(),
            "Bash(openspec show:*)".to_owned(),
            "Bash(openspec status:*)".to_owned(),
            "Bash(openspec validate:*)".to_owned(),
            "Bash(ls:*)".to_owned(),
        ];
        // Anything more — running tests during apply, say — is the project's
        // call: SPECTACULAR_CLAUDE_ARGS='--allowedTools Bash(bun test:*)'.
        args.extend(extra_args());
        AgentCommand {
            command: "claude".to_owned(),
            args,
        }
    }

    fn format_line(&self, line: &str) -> Option<String> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return None;
        }

        // Not JSON: the CLI's own diagnostics, which are worth showing verbatim
        // since they are usually why a job failed.
        let Ok(event) = serde_json::from_str::<StreamEvent>(trimmed) else {
            return Some(trimmed.to_owned());
        };

        match event.r#type.as_deref() {
            Some("assistant") => {
                let parts = event.message.unwrap_or_default().content;
                let text = parts
                    .iter()
                    .filter(|p| p.r#type.as_deref() == Some("text"))
                    .filter_map(|p| p.text.as_deref())
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ");
                if !text.is_empty() {
                    return Some(text);
                }

                let tools = parts
                    .iter()
                    .filter(|p| p.r#type.as_deref() == Some("tool_use"))
                    .filter_map(|p| p.name.as_deref())
                    .collect::<Vec<_>>();
                (!tools.is_empty()).then(|| format!("· {}", tools.join(", ")))
            }
            Some("result") => Some(if event.is_error.unwrap_or(false) {
                format!(
                    "failed: {}",
                    event.result.as_deref().unwrap_or("unknown error")
                )
            } else {
                "done".to_owned()
            }),
            // System init, user echoes, partial chunks: protocol noise.
            _ => None,
        }
    }

    fn structured(&self) -> Option<&dyn StructuredDriver> {
        Some(&ClaudeStructured)
    }
}

impl StructuredDriver for ClaudeStructured {
    fn build(&self, request: &StructuredRequest<'_>) -> AgentCommand {
        let mut args = vec![
            "-p".to_owned(),
            request.prompt.to_owned(),
            "--output-format".to_owned(),
            "json".to_owned(),
            "--json-schema".to_owned(),
            request.schema.to_string(),
            "--model".to_owned(),
            model_for(request.mode),
        ];
        // Web search at most: the advisor looks up current versions, and has
        // no business reading or editing the project. Other modes need none.
        if request.mode == StructuredMode::Research {
            args.extend([
                "--tools".to_owned(),
                "WebSearch".to_owned(),
                "--allowedTools".to_owned(),
                "WebSearch".to_owned(),
            ]);
        } else {
            args.extend(["--tools".to_owned(), String::new()]);
        }
        args.extend([
            "--no-session-persistence".to_owned(),
            // The user's MCP servers are irrelevant here and slow to start.
            "--strict-mcp-config".to_owned(),
        ]);
        AgentCommand {
            command: "claude".to_owned(),
            args,
        }
    }

    fn parse(&self, stdout: &str) -> Result<serde_json::Value, String> {
        let result: StructuredResult =
            serde_json::from_str(stdout).map_err(|err| err.to_string())?;
        if result.is_error.unwrap_or(false) {
            return Err(result
                .result
                .unwrap_or_else(|| "Claude Code reported an error".to_owned()));
        }
        result
            .structured_output
            .ok_or_else(|| "Claude Code returned no structured output".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn built() -> AgentCommand {
        ClaudeDriver.build(&AgentRequest {
            prompt: "write the design",
            cwd: "/p",
        })
    }

    fn after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        let at = args.iter().position(|a| a == flag)?;
        args.get(at + 1).map(String::as_str)
    }

    #[test]
    fn runs_non_interactively_with_streaming_output() {
        let built = built();
        assert_eq!(built.command, "claude");
        assert!(built.args.iter().any(|a| a == "-p"));
        assert!(built.args.iter().any(|a| a == "stream-json"));
        // stream-json requires --verbose; without it the CLI refuses to start,
        // which would look like a driver bug rather than a missing flag.
        assert!(built.args.iter().any(|a| a == "--verbose"));
        // Without it, a headless agent's every write is denied and it prints
        // the artifact instead of writing it.
        assert_eq!(after(&built.args, "--permission-mode"), Some("acceptEdits"));
        assert!(built.args.iter().any(|a| a == "Bash(openspec list:*)"));
    }

    #[test]
    fn passes_the_prompt_as_one_argv_entry_never_interpolated() {
        let nasty = ClaudeDriver.build(&AgentRequest {
            prompt: "a \"b\" $(echo c)",
            cwd: "/p",
        });
        assert!(nasty.args.iter().any(|a| a == "a \"b\" $(echo c)"));
    }

    #[test]
    fn renders_assistant_text() {
        let line = json!({
            "type": "assistant",
            "message": { "content": [{ "type": "text", "text": "Writing design.md" }] },
        })
        .to_string();
        assert_eq!(
            ClaudeDriver.format_line(&line).as_deref(),
            Some("Writing design.md")
        );
    }

    #[test]
    fn renders_tool_use_compactly() {
        let line = json!({
            "type": "assistant",
            "message": { "content": [{ "type": "tool_use", "name": "Write" }] },
        })
        .to_string();
        assert_eq!(ClaudeDriver.format_line(&line).as_deref(), Some("· Write"));
    }

    #[test]
    fn reports_the_result_success_or_failure() {
        let ok = json!({ "type": "result", "result": "ok" }).to_string();
        assert_eq!(ClaudeDriver.format_line(&ok).as_deref(), Some("done"));
        let bad = json!({ "type": "result", "is_error": true, "result": "boom" }).to_string();
        assert_eq!(
            ClaudeDriver.format_line(&bad).as_deref(),
            Some("failed: boom")
        );
    }

    #[test]
    fn drops_protocol_noise() {
        let init = json!({ "type": "system", "subtype": "init" }).to_string();
        assert_eq!(ClaudeDriver.format_line(&init), None);
        assert_eq!(ClaudeDriver.format_line(""), None);
        assert_eq!(ClaudeDriver.format_line("   "), None);
    }

    #[test]
    fn shows_non_json_output_verbatim_it_is_usually_why_a_job_failed() {
        assert_eq!(
            ClaudeDriver.format_line("command not found: claude").as_deref(),
            Some("command not found: claude")
        );
    }

    #[test]
    fn an_assistant_message_with_neither_text_nor_tools_is_dropped() {
        let line = json!({ "type": "assistant", "message": { "content": [] } }).to_string();
        assert_eq!(ClaudeDriver.format_line(&line), None);
    }

    #[test]
    fn is_asked_for_schema_shaped_json_with_web_search_and_nothing_else() {
        let structured = ClaudeDriver.structured().expect("claude can advise");
        let schema = json!({ "type": "object" });
        let research = structured.build(&StructuredRequest {
            prompt: "P",
            cwd: "/",
            schema: &schema,
            mode: StructuredMode::Research,
        });
        assert_eq!(research.command, "claude");
        assert!(research.args.iter().any(|a| a == "--json-schema"));
        assert_eq!(after(&research.args, "--tools"), Some("WebSearch"));
        assert!(research.args.iter().any(|a| a == "--strict-mcp-config"));

        let empty = json!({});
        let quick = structured.build(&StructuredRequest {
            prompt: "P",
            cwd: "/",
            schema: &empty,
            mode: StructuredMode::Quick,
        });
        assert_eq!(after(&quick.args, "--model"), Some("haiku"));
        assert_eq!(after(&quick.args, "--tools"), Some(""));
    }

    #[test]
    fn structured_output_is_unwrapped_and_errors_surface() {
        let structured = ClaudeDriver.structured().expect("claude can advise");
        let ok = json!({ "structured_output": { "a": 1 } }).to_string();
        assert_eq!(structured.parse(&ok), Ok(json!({ "a": 1 })));

        let bad = json!({ "is_error": true, "result": "no credit" }).to_string();
        assert_eq!(structured.parse(&bad), Err("no credit".to_owned()));

        let missing = json!({ "result": "hm" }).to_string();
        assert!(structured
            .parse(&missing)
            .expect_err("no structured output")
            .contains("no structured output"));
    }
}
