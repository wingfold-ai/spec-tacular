# spec-tacular

Review every requirement before your coding agent builds it. spec-tacular is a
terminal UI for spec-driven development on top of
[OpenSpec](https://github.com/Fission-AI/OpenSpec), for Claude Code and
opencode: accept, reject or defer each requirement your agent writes, one key at
a time, and design and tasks are drafted only from what you accepted.

## Install

```bash
npm i -g @fission-ai/openspec   # spec-tacular drives the OpenSpec CLI (1.11 or newer)
npm i -g @spec-tacular/cli
spec-tacular
```

Linux and macOS, x64 and arm64. npm installs the build for your platform as an
optional dependency, so don't install with `--omit=optional`. Without npm:
`curl -fsSL https://spec-tacular.app/install.sh | sh`.

## Links

- Documentation: https://spec-tacular.app/docs
- Source, issues and releases: https://github.com/wingfold-ai/spec-tacular
- Apache 2.0 licensed. The platform packages embed the Bun runtime and other packages;
  their licences are in each one's THIRD_PARTY_NOTICES.md.
