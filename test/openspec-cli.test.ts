/**
 * spec-tacular against the real OpenSpec CLI, through the adapter: the whole
 * surface it relies on, from a fresh project to an archived change.
 *
 * Skipped when no `openspec` is on the PATH. CI runs it once per supported
 * OpenSpec version (`.github/workflows/ci.yml`, the `openspec` matrix), so a
 * change in OpenSpec's JSON or behaviour shows up here, not in a user's TUI.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenSpecAdapter, openSpecToolsInstalled } from '../src/adapter/openspec.ts';
import { checkOpenSpecVersion } from '../src/adapter/version.ts';
import { initProject, SCHEMA_NAME } from '../src/core/init.ts';

const openspec = Bun.which('openspec');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A git repo with `openspec init` run for Claude Code and spec-tacular's schema installed. */
function project(): { root: string; adapter: OpenSpecAdapter } {
  const root = mkdtempSync(join(tmpdir(), 'spectacular-openspec-'));
  dirs.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync(openspec!, ['init', '--tools', 'claude'], { cwd: root, stdio: 'pipe' });
  initProject(root);
  return { root, adapter: new OpenSpecAdapter({ cwd: root, bin: openspec! }) };
}

const SPEC = `## ADDED Requirements

### Requirement: Export own data
The system SHALL let a signed-in user download all of their own expenses as a CSV file.

#### Scenario: User exports their data
- **WHEN** the user requests an export
- **THEN** the file contains every expense they created and nothing else
`;

describe.skipIf(!openspec)('with the real OpenSpec CLI', () => {
  test('its version is one spec-tacular supports', async () => {
    const { adapter } = project();
    const check = checkOpenSpecVersion(await adapter.version());
    expect(check.ok).toBe(true);
  }, 30_000);

  test('openspec init sets the agent up where spec-tacular looks for it', () => {
    const { root } = project();
    expect(openSpecToolsInstalled(root, 'claude')).toBe(true);
  }, 30_000);

  test('a change runs from new to archived on the spec-tacular schema', async () => {
    const { root, adapter } = project();
    await adapter.newChange('add-export', 'Let users export their data');

    // The fields of `status --json` that spec-tacular reads.
    const fresh = await adapter.status('add-export');
    expect(fresh.changeName).toBe('add-export');
    expect(fresh.schemaName).toBe(SCHEMA_NAME);
    expect(existsSync(fresh.changeRoot)).toBe(true);
    expect(fresh.artifacts.map((a) => a.id)).toEqual(['proposal', 'specs', 'risks', 'design', 'tasks']);
    expect(fresh.artifacts.find((a) => a.id === 'proposal')!.status).toBe('ready');
    expect(fresh.artifacts.find((a) => a.id === 'design')!.requires).toEqual(['specs', 'risks']);
    expect(fresh.artifactPaths['proposal']!.resolvedOutputPath).toBe(join(fresh.changeRoot, 'proposal.md'));
    expect(fresh.isPlanningComplete).toBe(false);
    expect(fresh.applyRequires).toEqual(['tasks']);

    const all = await adapter.statusAll();
    expect(all.changes.map((c) => c.changeName)).toEqual(['add-export']);
    expect(all.failed).toEqual([]);

    // What the agents are given: OpenSpec's instructions and templates.
    expect(await adapter.instructions('proposal', 'add-export')).toContain('proposal');
    for (const artifact of ['proposal', 'specs', 'risks', 'design', 'tasks']) {
      expect((await adapter.template(artifact, 'add-export')).length).toBeGreaterThan(0);
    }

    // Writing the artifacts moves the change along.
    const dir = fresh.changeRoot;
    writeFileSync(join(dir, 'proposal.md'), '## Why\nUsers need their data.\n\n## What Changes\n- Export as CSV\n\n## Capabilities\n### New Capabilities\n- `export`: data export\n\n## Boundary\n- src/export/\n');
    mkdirSync(join(dir, 'specs', 'export'), { recursive: true });
    writeFileSync(join(dir, 'specs', 'export', 'spec.md'), SPEC);
    writeFileSync(join(dir, 'risks.md'), '## Risks\n\n### Risk: Export leaks other users\n- **Hazard:** another user\'s expenses end up in the file\n- **Severity:** high\n- **Guard:** filter on the caller\n- **Check:** two users, one export\n');
    writeFileSync(join(dir, 'design.md'), '## Context\nCSV export.\n\n## Decisions\n- Stream rows.\n');
    writeFileSync(join(dir, 'tasks.md'), '## 1. Export\n- [x] 1.1 Add the endpoint\n');

    const written = await adapter.status('add-export');
    expect(written.artifacts.every((a) => a.status === 'done')).toBe(true);
    expect(written.isPlanningComplete).toBe(true);
    expect(written.artifactPaths['specs']!.existingOutputPaths).toEqual([join(dir, 'specs', 'export', 'spec.md')]);

    // Archive: the requirement joins the baseline, which validates as a spec.
    await adapter.archive('add-export');
    const baseline = join(root, 'openspec', 'specs', 'export', 'spec.md');
    expect(readFileSync(baseline, 'utf8')).toContain('### Requirement: Export own data');
    expect(await adapter.validate('export')).toMatch(/valid/i);
    expect((await adapter.statusAll()).changes).toEqual([]);
  }, 60_000);
});
