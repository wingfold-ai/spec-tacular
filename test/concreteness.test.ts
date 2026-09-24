import { describe, expect, test } from 'bun:test';
import { EMPTY_CONFIG, lintRequirement, lintText } from '../src/core/concreteness.ts';
import { parseSpecFile } from '../src/core/requirements.ts';

const values = (text: string, config = EMPTY_CONFIG) =>
  lintText(text, config).map((f) => f.value);
const kinds = (text: string) => lintText(text).map((f) => f.kind);

describe('what it flags', () => {
  test('an HTTP endpoint', () => {
    expect(values('The system SHALL expose POST /v1/export.')).toEqual(['POST /v1/export']);
    expect(kinds('GET /users/{id} returns a user.')).toEqual(['http-endpoint']);
  });

  test('a multi-segment path', () => {
    expect(values('Writes to /var/lib/things.')).toEqual(['/var/lib/things']);
  });

  test('a camelCase field or symbol', () => {
    expect(values('The response carries existingOutputPaths.')).toEqual(['existingOutputPaths']);
  });

  test('a snake_case field', () => {
    expect(values('Stores the user_email column.')).toEqual(['user_email']);
  });

  test('a code file', () => {
    expect(values('Implemented in exporter.ts.')).toEqual(['exporter.ts']);
  });

  test('scans scenarios as well as prose', () => {
    const [requirement] = parseSpecFile(
      `## ADDED Requirements

### Requirement: Export
The system SHALL export data.

#### Scenario: Works
- **WHEN** the user calls POST /v1/export
- **THEN** a file appears
`,
      'cap',
      '/p/specs/cap/spec.md',
    ).requirements;
    expect(lintRequirement(requirement!).map((f) => f.value)).toEqual(['POST /v1/export']);
  });
});

describe('what it does not flag', () => {
  test('ordinary prose', () => {
    expect(values('The system SHALL let a user export their data in a portable format.')).toEqual([]);
  });

  test('anything already marked as an example', () => {
    // The reviewer already answered the question.
    expect(values('SHALL expose an endpoint {{example: POST /v1/export}}.')).toEqual([]);
  });

  test('a single-segment path, which is usually prose', () => {
    expect(values('Writes to the /tmp directory.')).toEqual([]);
  });

  test('a PascalCase word in prose — it is probably a product name', () => {
    // PowerShell and OpenCode are names a spec may legitimately use; only
    // code formatting distinguishes them from an internal class.
    expect(values('Runs under PowerShell and OpenCode.')).toEqual([]);
  });

  test('but does flag PascalCase in code formatting', () => {
    expect(values('Dispatches through `ToolCommandAdapter`.')).toEqual(['ToolCommandAdapter']);
  });

  test('a framework that merely looks like a file', () => {
    // `Node.js` is not a file. Real file references are lowercase, kebab,
    // all-caps or multi-cap — none of which is a single capitalised word.
    expect(values('Requires Node.js 20.')).toEqual([]);
    expect(values('Built with Next.js.')).toEqual([]);
  });

  test('platform names shaped like camelCase', () => {
    expect(values('Runs on macOS and iOS.')).toEqual([]);
  });

  test('an acronym', () => {
    expect(values('Returns HTTP and JSON.')).toEqual([]);
  });

  test('a value on the project allowlist', () => {
    expect(values('Writes tasks.md.', { allow: ['tasks.md'], stack: [] })).toEqual([]);
  });

  test('a technology the project already committed to', () => {
    // Naming the stack is a decision made, not a premature one.
    expect(values('Persists via `Postgres`.', { allow: [], stack: ['Postgres'] })).toEqual([]);
  });

  test('the allowlist is case-insensitive', () => {
    expect(values('Writes TASKS.MD.', { allow: ['tasks.md'], stack: [] })).toEqual([]);
  });
});

describe('overlaps', () => {
  test('an endpoint is one finding, not also a bare path', () => {
    const findings = lintText('SHALL expose POST /v1/export today.');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('http-endpoint');
  });

  test('findings come back in document order', () => {
    const found = lintText('First userName then POST /a/b then other_field.');
    expect(found.map((f) => f.value)).toEqual(['userName', 'POST /a/b', 'other_field']);
  });
});

describe('it is advisory', () => {
  test('it reports, it does not judge', () => {
    // Every finding is a question for a human, because the linter cannot know
    // whether a value is a real contract — for a CLI, command names are.
    for (const f of lintText('SHALL expose POST /v1/x with user_id in `Thing`.')) {
      expect(f.question).toMatch(/^names /);
    }
  });

  test('empty text is no findings, not an error', () => {
    expect(lintText('')).toEqual([]);
  });
});
