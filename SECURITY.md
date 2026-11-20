# Security Policy

## Supported versions

spec-tacular is pre-1.0. Security fixes go into a new release; only the
[latest release](https://github.com/wingfold-ai/spec-tacular/releases/latest)
is supported. Run the install script again to update to it.

## Verifying a release

Every release archive has signed build provenance (SLSA, through Sigstore),
made by the release workflow. With the GitHub CLI:

```sh
gh attestation verify spec-tacular-<version>-<os>-<arch>.tar.gz --repo wingfold-ai/spec-tacular
```

`install.sh` checks each download against the release's `SHA256SUMS`.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a security
problem.**

Report it privately through GitHub's private vulnerability reporting: open
the repository's **Security** tab and choose **Report a vulnerability**, or go
straight to:

https://github.com/wingfold-ai/spec-tacular/security/advisories/new

Include what you can of the following:

- the version (`spec-tacular --version`) or the commit;
- your operating system, and the agent you use (Claude Code or opencode) with
  its version;
- how to reproduce the problem, or a proof of concept;
- the impact you expect an attacker could achieve.

## Scope

In scope:

- **The `spec-tacular` binary** and the source in this repository.
- **`install.sh`**, also served at `https://spec-tacular.app/install.sh`: how
  it picks, downloads, checks and installs a build.
- **Release artifacts**: the archives on GitHub Releases, their `.sha256`
  files and `SHA256SUMS`, and the workflows that build and publish them.
- **How spec-tacular starts the agents**: the permissions it gives Claude Code
  and opencode, the commands it lets them run without asking, and how it
  handles MCP servers. By default the drafting agents load your Claude Code
  MCP servers and may call their tools unattended; `SPECTACULAR_NO_MCP` and
  `SPECTACULAR_MCP_DENY` limit that (see the README). A way to make an agent
  do more than these settings allow, or to get it to run commands from a
  project's content without the user's say, is in scope.
- **The files spec-tacular writes** to a project, in `spec-tacular/`,
  `.spec-tacular/` and `openspec/changes/`, for example a secret ending up in
  a file that is meant to be committed.

Out of scope:

- Vulnerabilities in Claude Code, opencode, OpenSpec, Bun or OpenTUI
  themselves. Report those to their projects. If spec-tacular makes one
  worse, that part is in scope.
- What an agent does within the permissions you gave it yourself, for
  example in your own permission mode while implementing, or through
  `SPECTACULAR_CLAUDE_ARGS`.
- The spec-tacular.app website, unless it serves something other than this
  repository's `install.sh`.

## What to expect

spec-tacular is maintained by one person, Marius Högger
([mhoegger](https://github.com/mhoegger) on GitHub), so these are aims, not
guarantees:

- an acknowledgement within a week;
- an answer on whether the problem can be reproduced and what will be done
  about it;
- a fix in a new release as soon as is practical, with the publication date
  agreed with you;
- a GitHub Security Advisory for a confirmed vulnerability, crediting you
  unless you ask not to be named.
