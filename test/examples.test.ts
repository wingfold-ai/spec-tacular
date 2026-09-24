import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  exampleValues,
  findExamples,
  markAsExample,
  renderExamples,
} from '../src/core/examples.ts';
import { markExampleInFile } from '../src/core/mark.ts';
import { hashBlock, parseSpecFile } from '../src/core/requirements.ts';

describe('the notation', () => {
  test('finds marked values with their offsets', () => {
    const spans = findExamples('SHALL expose {{example: POST /v1/x}} today.');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.value).toBe('POST /v1/x');
    expect('SHALL expose {{example: POST /v1/x}} today.'.slice(spans[0]!.start, spans[0]!.end))
      .toBe('{{example: POST /v1/x}}');
  });

  test('is case- and whitespace-tolerant', () => {
    expect(exampleValues('{{ Example:  CSV }}')).toEqual(['CSV']);
  });

  test('renders without the braces, since they are noise on screen', () => {
    expect(renderExamples('Returns {{example: CSV}} data.')).toBe('Returns CSV data.');
  });

  test('a stray brace ends the span rather than swallowing the paragraph', () => {
    expect(exampleValues('{{example: a} and then a whole lot more text')).toEqual([]);
  });

  test('handles several in one text', () => {
    expect(exampleValues('{{example: A}} and {{example: B}}')).toEqual(['A', 'B']);
  });
});

describe('markAsExample', () => {
  test('wraps the first occurrence', () => {
    expect(markAsExample('SHALL expose POST /v1/x.', 'POST /v1/x')).toBe(
      'SHALL expose {{example: POST /v1/x}}.',
    );
  });

  test('declines when the value is absent rather than guessing', () => {
    expect(markAsExample('nothing here', 'POST /v1/x')).toBeNull();
  });

  test('skips an occurrence already inside a marked example', () => {
    const text = '{{example: CSV}} and then CSV again';
    expect(markAsExample(text, 'CSV')).toBe('{{example: CSV}} and then {{example: CSV}} again');
  });

  test('declines when every occurrence is already marked', () => {
    expect(markAsExample('{{example: CSV}}', 'CSV')).toBeNull();
  });

  test('declines an empty value', () => {
    expect(markAsExample('anything', '  ')).toBeNull();
  });
});

const dirs: string[] = [];
const spec = (body: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'spectacular-mark-'));
  dirs.push(dir);
  const file = join(dir, 'spec.md');
  writeFileSync(file, body, 'utf8');
  return file;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SPEC = `# Spec Delta

## ADDED Requirements

### Requirement: Alpha
The system SHALL expose POST /v1/export.

#### Scenario: Works
- **WHEN** called
- **THEN** it works

### Requirement: Beta
The system SHALL also mention POST /v1/export.
`;

describe('markExampleInFile', () => {
  const load = (file: string) =>
    parseSpecFile(readFileSync(file, 'utf8'), 'cap', file).requirements;

  test('marks the value and leaves the rest of the file alone', () => {
    const file = spec(SPEC);
    const [alpha] = load(file);

    expect(markExampleInFile(alpha!, 'POST /v1/export')).toEqual({
      ok: true,
      value: 'POST /v1/export',
    });

    const updated = readFileSync(file, 'utf8');
    expect(updated).toContain('SHALL expose {{example: POST /v1/export}}.');
    // Scoped to the requirement's own block: an identical value in another
    // requirement must not be rewritten behind the reviewer's back.
    expect(updated).toContain('SHALL also mention POST /v1/export.');
    expect(updated).toContain('#### Scenario: Works');
  });

  test('marking changes the hash, so acceptance resets', () => {
    // Marking is an edit to what the requirement promises, not a cosmetic one.
    const file = spec(SPEC);
    const before = load(file)[0]!;
    markExampleInFile(before, 'POST /v1/export');
    const after = load(file)[0]!;
    expect(after.hash).not.toBe(before.hash);
    expect(hashBlock('x')).not.toBe(after.hash);
  });

  test('the second requirement can be marked independently', () => {
    const file = spec(SPEC);
    const beta = load(file)[1]!;
    expect(markExampleInFile(beta!, 'POST /v1/export').ok).toBe(true);
    const updated = readFileSync(file, 'utf8');
    expect(updated).toContain('SHALL expose POST /v1/export.');
    expect(updated).toContain('SHALL also mention {{example: POST /v1/export}}.');
  });

  test('declines a value that is not in this requirement', () => {
    const file = spec(SPEC);
    const result = markExampleInFile(load(file)[0]!, 'GET /nope');
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain('not in this requirement');
    expect(readFileSync(file, 'utf8')).toBe(SPEC);
  });

  test('refuses when the file moved under it', () => {
    // Editing by a stale offset would corrupt the spec.
    const file = spec(SPEC);
    const stale = load(file)[0]!;
    writeFileSync(file, '# Spec Delta\n\n(replaced)\n', 'utf8');
    const result = markExampleInFile(stale, 'POST /v1/export');
    expect(result.ok === false && result.reason).toContain('changed since it was read');
  });

  test('reports a missing file instead of throwing', () => {
    const result = markExampleInFile(
      { ...load(spec(SPEC))[0]!, file: '/nope/missing.md' },
      'POST /v1/export',
    );
    expect(result).toMatchObject({ ok: false });
  });
});
