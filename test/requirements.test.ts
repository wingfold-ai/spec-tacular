import { describe, expect, test } from 'bun:test';
import {
  capabilityFromPath,
  hashBlock,
  normalizeForHash,
  parseSpecFile,
  slugify,
} from '../src/core/requirements.ts';

const parse = (md: string, cap = 'cap') => parseSpecFile(md, cap, `/p/specs/${cap}/spec.md`);

describe('parseSpecFile', () => {
  test('reads requirements, prose and scenarios from a delta section', () => {
    const { requirements } = parse(`## ADDED Requirements

### Requirement: Theme selection
The app SHALL let users switch themes.

#### Scenario: User toggles
- **WHEN** clicked
- **THEN** it switches
`);
    expect(requirements).toHaveLength(1);
    const r = requirements[0]!;
    expect(r.name).toBe('Theme selection');
    expect(r.operation).toBe('ADDED');
    expect(r.text).toBe('The app SHALL let users switch themes.');
    expect(r.scenarios).toHaveLength(1);
    expect(r.scenarios[0]!.name).toBe('User toggles');
    expect(r.scenarios[0]!.body).toEqual(['- **WHEN** clicked', '- **THEN** it switches']);
    expect(r.id).toBe('cap#theme-selection');
    expect(r.line).toBe(3);
  });

  test('tracks the operation of each delta section independently', () => {
    const { requirements } = parse(`## ADDED Requirements

### Requirement: A
a

## MODIFIED Requirements

### Requirement: B
b

## REMOVED Requirements

### Requirement: C
c
`);
    expect(requirements.map((r) => [r.name, r.operation])).toEqual([
      ['A', 'ADDED'],
      ['B', 'MODIFIED'],
      ['C', 'REMOVED'],
    ]);
  });

  test('ignores requirements inside fenced code blocks', () => {
    // The schema's own instructions show example requirements in fences, so a
    // parser without fence masking invents requirements on nearly every spec.
    const { requirements } = parse(`## ADDED Requirements

### Requirement: Real
real

\`\`\`markdown
### Requirement: Fake
not real

#### Scenario: Fake scenario
\`\`\`
`);
    expect(requirements.map((r) => r.name)).toEqual(['Real']);
    expect(requirements[0]!.scenarios).toHaveLength(0);
  });

  test('a non-delta ## section ends the current one', () => {
    const { requirements } = parse(`## ADDED Requirements

### Requirement: A
a

## Impact

Some prose that must not be swallowed.

### Requirement: NotARequirement
`);
    expect(requirements.map((r) => r.name)).toEqual(['A']);
    expect(requirements[0]!.text).toBe('a');
  });

  test('reads a main spec Requirements section', () => {
    const { requirements } = parse(`## Purpose

Something.

## Requirements

### Requirement: Baseline
b
`);
    expect(requirements.map((r) => [r.name, r.operation])).toEqual([['Baseline', 'ADDED']]);
  });

  test('normalizes CRLF and a BOM', () => {
    const { requirements } = parse('\uFEFF## ADDED Requirements\r\n\r\n### Requirement: A\r\ntext\r\n');
    expect(requirements).toHaveLength(1);
    expect(requirements[0]!.text).toBe('text');
  });

  test('accepts ###Requirement: with no space, case-insensitively', () => {
    const { requirements } = parse('## added requirements\n\n###requirement: Squished\nx\n');
    expect(requirements.map((r) => r.name)).toEqual(['Squished']);
  });

  test('strips a closing run of hashes but keeps a trailing # in a name', () => {
    expect(parse('## ADDED Requirements\n\n### Requirement: Foo ###\nx\n').requirements[0]!.name).toBe('Foo');
    expect(parse('## ADDED Requirements\n\n### Requirement: C#\nx\n').requirements[0]!.name).toBe('C#');
  });

  test('disambiguates requirement names that slugify identically', () => {
    const { requirements } = parse(`## ADDED Requirements

### Requirement: Log in
a

### Requirement: Log-in
b
`);
    // Without this they would share one id and silently merge into one
    // review entry, hiding a requirement from the human entirely.
    expect(requirements.map((r) => r.id)).toEqual(['cap#log-in', 'cap#log-in~2']);
  });

  test('a bare #### header is still a scenario boundary', () => {
    const { requirements } = parse(`## ADDED Requirements

### Requirement: A
prose

#### Not prefixed
- body
`);
    expect(requirements[0]!.text).toBe('prose');
    expect(requirements[0]!.scenarios[0]!.name).toBe('Not prefixed');
  });

  test('an empty document yields nothing rather than throwing', () => {
    expect(parse('').requirements).toEqual([]);
    expect(parse('# Spec Delta\n').requirements).toEqual([]);
  });
});

describe('RENAMED parsing', () => {
  test('pairs FROM with its following TO', () => {
    const { renames } = parse(`## RENAMED Requirements

- FROM: \`### Requirement: Old name\`
- TO: \`### Requirement: New name\`
`);
    expect(renames).toEqual([{ from: 'Old name', to: 'New name', capability: 'cap' }]);
  });

  test('drops a FROM displaced by another FROM before its TO', () => {
    const { renames } = parse(`## RENAMED Requirements

- FROM: \`### Requirement: A\`
- FROM: \`### Requirement: B\`
- TO: \`### Requirement: B2\`
`);
    expect(renames).toEqual([{ from: 'B', to: 'B2', capability: 'cap' }]);
  });

  test('drops an unpaired trailing FROM', () => {
    expect(parse('## RENAMED Requirements\n\n- FROM: `### Requirement: A`\n').renames).toEqual([]);
  });

  test('a RENAMED section produces no requirements', () => {
    const { requirements } = parse('## RENAMED Requirements\n\n- FROM: `### Requirement: A`\n- TO: `### Requirement: B`\n');
    expect(requirements).toEqual([]);
  });
});

describe('hashing', () => {
  test('cosmetic whitespace changes do not change the hash', () => {
    // Reformatting a file must not silently revoke a human's acceptance.
    const a = '### Requirement: A\nThe system SHALL work.\n';
    const b = '### Requirement: A\n\n\nThe  system   SHALL work.   \n\n';
    expect(hashBlock(a)).toBe(hashBlock(b));
  });

  test('a word change does change the hash', () => {
    expect(hashBlock('### Requirement: A\nSHALL work.')).not.toBe(
      hashBlock('### Requirement: A\nSHALL NOT work.'),
    );
  });

  test('case is significant', () => {
    expect(normalizeForHash('SHALL')).not.toBe(normalizeForHash('shall'));
  });
});

describe('helpers', () => {
  test('slugify handles punctuation and all-punctuation names', () => {
    expect(slugify('Theme selection!')).toBe('theme-selection');
    expect(slugify('  A / B  ')).toBe('a-b');
    expect(slugify('!!!')).toBe('unnamed');
  });

  test('capabilityFromPath keeps nested capability paths', () => {
    expect(capabilityFromPath('/p/changes/c/specs/user-auth/spec.md')).toBe('user-auth');
    expect(capabilityFromPath('/p/changes/c/specs/identity/user-auth/spec.md')).toBe('identity/user-auth');
    expect(capabilityFromPath('C:\\p\\specs\\cli-view\\spec.md')).toBe('cli-view');
  });
});
