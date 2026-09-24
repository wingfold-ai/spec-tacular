import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addToRegister,
  findEntry,
  loadRegister,
  registerPath,
  saveRegister,
  type PendingEntry,
} from '../src/core/pending.ts';
import { verifyRequirement, specFileFor } from '../src/core/verify.ts';

const dirs: string[] = [];
const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-pending-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const entry = (over: Partial<PendingEntry> = {}): PendingEntry => ({
  capability: 'data-export',
  name: 'Export completes against a deployed instance',
  body: 'The system SHALL complete an export end to end.\n\n#### Scenario: Deployed\n- **WHEN** run against a deployment\n- **THEN** a file is produced',
  change: 'add-export',
  deferred: '2026-09-21',
  needs: 'a deployed instance',
  ...over,
});

describe('the register', () => {
  test('round-trips an entry with its metadata', () => {
    const r = root();
    saveRegister(r, [entry()]);
    const [loaded] = loadRegister(r);

    expect(loaded).toEqual(entry());
    // The scenario survives, because verifying must write back exactly what
    // was reviewed.
    expect(loaded!.body).toContain('#### Scenario: Deployed');
  });

  test('metadata is kept out of the body', () => {
    const r = root();
    saveRegister(r, [entry()]);
    expect(loadRegister(r)[0]!.body).not.toContain('**Needs:**');
    expect(readFileSync(registerPath(r), 'utf8')).toContain('**Needs:** a deployed instance');
  });

  test('groups by capability', () => {
    const r = root();
    saveRegister(r, [entry(), entry({ capability: 'auth', name: 'Login works' })]);
    const content = readFileSync(registerPath(r), 'utf8');
    expect(content.indexOf('## auth')).toBeLessThan(content.indexOf('## data-export'));
    expect(loadRegister(r).map((e) => e.capability)).toEqual(['auth', 'data-export']);
  });

  test('an empty register says so rather than being blank', () => {
    const r = root();
    saveRegister(r, []);
    expect(readFileSync(registerPath(r), 'utf8')).toContain('Nothing is waiting on validation');
    expect(loadRegister(r)).toEqual([]);
  });

  test('a missing register is empty, not an error', () => {
    expect(loadRegister(root())).toEqual([]);
  });

  test('adding replaces a matching entry rather than duplicating it', () => {
    const r = root();
    addToRegister(r, [entry()]);
    addToRegister(r, [entry({ needs: 'a staging deployment' })]);
    const all = loadRegister(r);
    expect(all).toHaveLength(1);
    expect(all[0]!.needs).toBe('a staging deployment');
  });

  test('findEntry ignores case and spacing', () => {
    const entries = [entry()];
    expect(findEntry(entries, 'data-export', 'export  completes Against a deployed instance')).not.toBeNull();
    expect(findEntry(entries, 'other', entry().name)).toBeNull();
  });
});

describe('verifying into the baseline', () => {
  const withSpec = (content: string) => {
    const r = root();
    const file = specFileFor(r, 'data-export');
    mkdirSync(join(r, 'openspec', 'specs', 'data-export'), { recursive: true });
    writeFileSync(file, content, 'utf8');
    return { r, file };
  };

  test('appends the requirement and removes it from the register', () => {
    const { r, file } = withSpec(
      '# data-export\n\n## Purpose\n\nExporting.\n\n## Requirements\n\n### Requirement: Existing\nThe system SHALL already do this.\n',
    );
    addToRegister(r, [entry()]);

    const result = verifyRequirement(r, 'data-export', entry().name);
    expect(result.ok).toBe(true);

    const spec = readFileSync(file, 'utf8');
    expect(spec).toContain('### Requirement: Existing');
    expect(spec).toContain('### Requirement: Export completes against a deployed instance');
    expect(spec).toContain('#### Scenario: Deployed');
    expect(loadRegister(r)).toEqual([]);
  });

  test('inserts inside the Requirements section, not at the end of the file', () => {
    // A requirement written under a later section would be lost to the parser.
    const { r, file } = withSpec(
      '# data-export\n\n## Requirements\n\n### Requirement: Existing\nText.\n\n## Notes\n\nTrailing prose.\n',
    );
    addToRegister(r, [entry()]);
    verifyRequirement(r, 'data-export', entry().name);

    const spec = readFileSync(file, 'utf8');
    expect(spec.indexOf('Export completes')).toBeLessThan(spec.indexOf('## Notes'));
    expect(spec).toContain('Trailing prose.');
  });

  test('creates the spec when the capability has none, flagging the Purpose', () => {
    // Every requirement of a brand-new capability can be deferred, leaving no
    // spec to append to.
    const r = root();
    addToRegister(r, [entry()]);
    const result = verifyRequirement(r, 'data-export', entry().name);

    expect(result.ok === true && result.created).toBe(true);
    const spec = readFileSync(specFileFor(r, 'data-export'), 'utf8');
    expect(spec).toContain('## Purpose');
    expect(spec).toContain('TBD');
    expect(spec).toContain('### Requirement: Export completes against a deployed instance');
  });

  test('refuses a requirement the spec already has', () => {
    const { r } = withSpec(
      `# data-export\n\n## Requirements\n\n### Requirement: ${entry().name}\nAlready here.\n`,
    );
    addToRegister(r, [entry()]);
    const result = verifyRequirement(r, 'data-export', entry().name);
    expect(result.ok === false && result.reason).toContain('already in the spec');
    // And the register is untouched, so nothing is lost.
    expect(loadRegister(r)).toHaveLength(1);
  });

  test('refuses an entry that is not pending', () => {
    const result = verifyRequirement(root(), 'data-export', 'Nothing like this');
    expect(result.ok === false && result.reason).toContain('nothing pending');
  });

  test('appends a Requirements section when the spec has none', () => {
    const { r, file } = withSpec('# data-export\n\n## Purpose\n\nExporting.\n');
    addToRegister(r, [entry()]);
    expect(verifyRequirement(r, 'data-export', entry().name).ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('## Requirements');
  });
});
