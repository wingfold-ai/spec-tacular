import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSpecToolsInstalled } from '../src/adapter/openspec.ts';

const dirs: string[] = [];
const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-tools-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const skill = (r: string, ...at: string[]) => mkdirSync(join(r, ...at, 'skills', 'openspec-apply-change'), { recursive: true });

describe('whether openspec init set up the agent', () => {
  test('OpenSpec 1: a copy of the skills per agent', () => {
    const r = root();
    skill(r, '.claude');
    skill(r, '.opencode');
    expect(openSpecToolsInstalled(r, 'claude')).toBe(true);
    expect(openSpecToolsInstalled(r, 'opencode')).toBe(true);
  });

  test('OpenSpec 2: opencode reads .agents/skills itself', () => {
    const r = root();
    skill(r, '.agents');
    expect(openSpecToolsInstalled(r, 'opencode')).toBe(true);
    // Claude Code does not read .agents/: OpenSpec links the skills into .claude/.
    expect(openSpecToolsInstalled(r, 'claude')).toBe(false);
    mkdirSync(join(r, '.claude', 'skills'), { recursive: true });
    symlinkSync('../../.agents/skills/openspec-apply-change', join(r, '.claude', 'skills', 'openspec-apply-change'));
    expect(openSpecToolsInstalled(r, 'claude')).toBe(true);
  });

  test('not set up: neither folder has the skills', () => {
    const r = root();
    expect(openSpecToolsInstalled(r, 'claude')).toBe(false);
    expect(openSpecToolsInstalled(r, 'opencode')).toBe(false);
  });

  test('an agent OpenSpec does not know is not checked', () => {
    expect(openSpecToolsInstalled(root(), 'other')).toBe(true);
  });
});
