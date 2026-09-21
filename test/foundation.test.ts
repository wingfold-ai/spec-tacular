import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FOUNDATION_DOCS,
  foundationDir,
  isUnanswered,
  loadFoundation,
  parseFoundationDoc,
  scaffoldFoundation,
} from '../src/core/foundation.ts';
import { buildContext, renderContext } from '../src/core/context.ts';
import { parseDecisions, promoteDecision } from '../src/core/decisions.ts';

const dirs: string[] = [];
const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-fnd-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('scaffolding', () => {
  test('writes a document per area with every question unanswered', () => {
    // A default nobody chose is indistinguishable from a decision, which is
    // the failure this phase exists to prevent.
    const r = root();
    const result = scaffoldFoundation(r);
    expect(result.created).toEqual(FOUNDATION_DOCS.map((d) => d.name));

    const stack = readFileSync(join(foundationDir(r), 'stack.md'), 'utf8');
    expect(stack).toContain('# Stack');
    expect(stack).toContain('## Language and runtime, with versions.');
    expect(stack).toContain('TBD');
  });

  test('never overwrites answers that already exist', () => {
    const r = root();
    scaffoldFoundation(r);
    writeFileSync(join(foundationDir(r), 'stack.md'), '# Stack\n\n## Language\n\nTypeScript.\n');

    const again = scaffoldFoundation(r);
    expect(again.created).toEqual([]);
    expect(again.skipped).toContain('stack.md');
    expect(readFileSync(join(foundationDir(r), 'stack.md'), 'utf8')).toContain('TypeScript.');
  });
});

describe('parsing', () => {
  test('each section is a reviewable item', () => {
    const items = parseFoundationDoc(
      '# Stack\n\n## Language\n\nTypeScript.\n\n## Datastore\n\nPostgres.\n',
      '/p/spec-tacular/foundation/stack.md',
      'stack.md',
    );
    expect(items.map((i) => [i.id, i.name])).toEqual([
      ['foundation/stack#language', 'Language'],
      ['foundation/stack#datastore', 'Datastore'],
    ]);
    expect(items[0]!.text).toBe('TypeScript.');
    expect(items[0]!.hash).toStartWith('sha256:');
  });

  test('loads every document in a stable order', () => {
    const r = root();
    scaffoldFoundation(r);
    const groups = [...new Set(loadFoundation(r).map((i) => i.capability))];
    expect(groups).toEqual([
      'foundation/architecture',
      'foundation/conventions',
      'foundation/stack',
    ]);
  });

  test('an absent foundation is empty, not an error', () => {
    expect(loadFoundation(root())).toEqual([]);
  });

  test('recognises an unanswered question', () => {
    const [tbd, answered] = parseFoundationDoc(
      '# Stack\n\n## A\n\nTBD\n\n## B\n\nBun.\n',
      '/p/f/stack.md',
      'stack.md',
    );
    expect(isUnanswered(tbd!)).toBe(true);
    expect(isUnanswered(answered!)).toBe(false);
  });
});

describe('the context bundle', () => {
  test('carries the foundation once it exists', () => {
    const r = root();
    mkdirSync(foundationDir(r), { recursive: true });
    writeFileSync(join(foundationDir(r), 'stack.md'), '# Stack\n\nRuntime is `Bun`.\n');

    const bundle = buildContext(r, []);
    expect(bundle.foundation.map((d) => d.name)).toEqual(['stack.md']);
    expect(renderContext(bundle)).toContain('Runtime is `Bun`.');
    expect(bundle.missing).toEqual(['no architectural decision records yet']);
  });

  test('carries accepted ADRs but not superseded ones', () => {
    const r = root();
    const decision = parseDecisions(
      '## Decisions\n\n### Errors\n**Scope: global**\n\nErrors are values.\n',
      '/p/design.md',
    )[0]!;
    promoteDecision(r, decision);
    promoteDecision(r, { ...decision, name: 'Errors reversed', body: 'Errors are exceptions.' }, { supersedes: 1 });

    const rendered = renderContext(buildContext(r, []));
    expect(rendered).toContain('Errors are exceptions.');
    expect(rendered).not.toContain('Errors are values.');
  });
});
