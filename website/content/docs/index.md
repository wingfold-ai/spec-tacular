---
title: Introduction
description: spec-tacular is a terminal UI that adds a review loop to OpenSpec. What it is, who it is for, and where to go next.
---

spec-tacular is a terminal UI for spec-driven development. It runs on top of [OpenSpec](https://github.com/Fission-AI/OpenSpec) and adds the review step that OpenSpec lacks. This page explains what it adds, who it is for, and how these docs are organised.

## What it is, and what it is not

OpenSpec writes the artifacts of a change: a proposal, specs, a design, tasks, and an archive. In OpenSpec a stage counts as complete when its file exists. You read the Markdown in your editor, and nothing records whether anyone agreed with it.

spec-tacular adds the missing half. It gives you a keyboard-driven review loop, an explicit accept or reject decision for each requirement, and a pipeline that is always on screen.

spec-tacular does not replace OpenSpec. It drives the `openspec` CLI, installs its own OpenSpec schema into your project, and leaves your changes in `openspec/changes/` where they always were. Your review decisions are saved next to each change, in `openspec/changes/<id>/review.md`, and that file reads the same without spec-tacular.

## Who it is for

You write code with an agent in the terminal, either [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [opencode](https://opencode.ai). You want the agent to build what you agreed to, not what it guessed. If you already use OpenSpec, you can start right away: spec-tacular opens on an existing OpenSpec project.

## The core idea

**An artifact is complete when a human accepted it.** A file that exists is only a draft.

**The order is strict:** proposal → specs → risks → design → tasks. Each stage waits until you have accepted the one before it. For example, an agent cannot draft the design while specs are still unreviewed.

**Specs are reviewed one requirement at a time.** For each requirement, press :key-cap{k="a"} to accept, :key-cap{k="x"} to reject (you say why), :key-cap{k="d"} to defer (you say what would verify it), or :key-cap{k="r"} to revise it with AI. Risks are reviewed the same way. The proposal, design and tasks are read and accepted as a whole.

**An acceptance holds for the text you read.** Edit or redraft a document and it waits for you to read it again.

Around that core, spec-tacular adds project ground rules before the first change, a roadmap that splits a new idea into small slices, and a boundary in each proposal that names the files the change expects to touch. The boundary is advisory: files changed outside it are flagged, not blocked.

## Terms used in these docs

| Term | Meaning |
| --- | --- |
| Change | One piece of work, small enough to review in one sitting. Each change is a folder in `openspec/changes/`, as in OpenSpec. |
| Schema | The OpenSpec schema spec-tacular installs into `openspec/schemas/spec-tacular/`. It gives OpenSpec the stages of a change and their order: proposal → specs → risks → design → tasks. |
| Ground rules | The project's domain, stack, architecture and conventions, settled before the first change. Every agent reads them. They live in `spec-tacular/foundation/`, and their guide is [Ground rules (Foundation)](/docs/guides/foundation). |
| Slice | One step on a new project's roadmap. Each slice becomes one change. |
| Boundary | The `## Boundary` section of a proposal: the paths the change expects to touch. Files changed outside it are listed, not blocked. |
| Driver | The agent spec-tacular runs: `claude` (Claude Code, the default) or `opencode`, chosen with `--driver`. |
| Apply | The last stage in the pipeline bar: implementing the tasks. |
| Baseline | The accepted specs in `openspec/specs/`. Archiving a change merges its accepted requirements into it. |
| MCP | Model Context Protocol servers: extra tools connected to Claude Code. The agents spec-tacular starts load them by default. See [Installation](/docs/getting-started/installation#mcp-servers). |

## How these docs are organised

- **Getting started.** [Installation](/docs/getting-started/installation) sets up the tools. The [Quickstart](/docs/getting-started/quickstart) takes an existing OpenSpec project to a first accepted change. [Start a new project](/docs/getting-started/new-project) begins from an empty folder.
- **Guides.** How each part works: [reviewing](/docs/guides/reviewing), [the pipeline](/docs/guides/pipeline), [ground rules](/docs/guides/foundation), [the roadmap](/docs/guides/roadmap), [decisions](/docs/guides/decisions), [risks](/docs/guides/risks), [implementing and archiving](/docs/guides/implement-and-archive), and [defects](/docs/guides/defects).
- **Advanced.** More rigor where a failure costs most: [consequence classes](/docs/advanced/consequence-classes), [verification](/docs/advanced/verification), and [formal requirements](/docs/advanced/formal-requirements).
- **Reference.** [Keys](/docs/reference/keys), [CLI](/docs/reference/cli), [files](/docs/reference/files), [configuration](/docs/reference/configuration), and [troubleshooting](/docs/reference/troubleshooting).

## Requirements at a glance

| You need | Notes |
| --- | --- |
| Linux or macOS | x64 or arm64. There is no Windows build. |
| The OpenSpec CLI | 1.11 or newer, OpenSpec 2 included: `npm i -g @fission-ai/openspec`. |
| Claude Code or opencode | Installed and signed in. Claude Code is the default. |
| spec-tacular | A single binary. It needs no Bun or Node of its own. |

## Next

- [Install spec-tacular](/docs/getting-started/installation)
- [Quickstart: your first reviewed change](/docs/getting-started/quickstart)
