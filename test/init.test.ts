import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledSchemaDir, initProject, setProjectSchema, SCHEMA_NAME } from '../src/core/init.ts';

const dirs: string[] = [];
const project = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-init-'));
  dirs.push(d);
  mkdirSync(join(d, 'openspec'), { recursive: true });
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const configOf = (root: string) => readFileSync(join(root, 'openspec', 'config.yaml'), 'utf8');

describe('initProject', () => {
  test('installs the schema and its templates', () => {
    const root = project();
    const result = initProject(root);

    expect(result.schemaDir).toBe(join(root, 'openspec', 'schemas', SCHEMA_NAME));
    expect(result.files).toEqual([
      'schema.yaml',
      'templates/design.md',
      'templates/proposal.md',
      'templates/spec.md',
      'templates/tasks.md',
    ]);
    expect(existsSync(join(result.schemaDir, 'schema.yaml'))).toBe(true);
  });

  test('the installed schema sequences design after specs', () => {
    // The whole reason the schema exists (problem-analysis §1).
    const root = project();
    const yaml = readFileSync(join(initProject(root).schemaDir, 'schema.yaml'), 'utf8');
    const design = yaml.slice(yaml.indexOf('- id: design'));
    expect(design.slice(0, design.indexOf('- id: tasks'))).toContain('- specs');
  });

  test('points the project config at the schema', () => {
    const root = project();
    const result = initProject(root);
    expect(result.configUpdated).toBe(true);
    expect(configOf(root)).toContain(`schema: ${SCHEMA_NAME}`);
  });

  test('reports a replacement so local edits are not lost silently', () => {
    const root = project();
    expect(initProject(root).replaced).toBe(false);
    const again = initProject(root);
    expect(again.replaced).toBe(true);
    expect(again.notes.join(' ')).toContain('Local edits');
  });

  test('says the schema applies to new changes only', () => {
    // Existing changes pin their schema in their own .openspec.yaml.
    expect(initProject(project()).notes.join(' ')).toContain('already in flight keep theirs');
  });

  test('--setSchema false leaves the config alone', () => {
    const root = project();
    writeFileSync(join(root, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
    expect(initProject(root, { setSchema: false }).configUpdated).toBe(false);
    expect(configOf(root)).toContain('schema: spec-driven');
  });

  test('the bundled schema ships with the package', () => {
    expect(existsSync(join(bundledSchemaDir(), 'schema.yaml'))).toBe(true);
  });
});

describe('setProjectSchema', () => {
  test('creates a config when none exists', () => {
    const root = project();
    expect(setProjectSchema(root, 'x')).toBe(true);
    expect(configOf(root)).toBe('schema: x\n');
  });

  test('rewrites only the schema line, preserving context and rules', () => {
    // config.yaml is hand-maintained and holds a project's house rules;
    // replacing it wholesale would destroy real work.
    const root = project();
    const original = [
      'schema: spec-driven',
      '',
      'context: |',
      '  Tech stack: TypeScript',
      '',
      'rules:',
      '  specs:',
      '    - Prefer observable behaviour',
      '',
    ].join('\n');
    writeFileSync(join(root, 'openspec', 'config.yaml'), original);

    setProjectSchema(root, SCHEMA_NAME);
    const updated = configOf(root);
    expect(updated).toContain(`schema: ${SCHEMA_NAME}`);
    expect(updated).not.toContain('spec-driven');
    expect(updated).toContain('Tech stack: TypeScript');
    expect(updated).toContain('- Prefer observable behaviour');
  });

  test('prepends a schema key when the config has none', () => {
    const root = project();
    writeFileSync(join(root, 'openspec', 'config.yaml'), 'context: |\n  Something\n');
    setProjectSchema(root, 'x');
    expect(configOf(root)).toBe('schema: x\ncontext: |\n  Something\n');
  });

  test('does not touch a nested schema key', () => {
    const root = project();
    writeFileSync(
      join(root, 'openspec', 'config.yaml'),
      'context: |\n  schema: not-the-real-one\nschema: spec-driven\n',
    );
    setProjectSchema(root, 'x');
    const updated = configOf(root);
    expect(updated).toContain('  schema: not-the-real-one');
    expect(updated).toContain('schema: x');
  });

  test('is a no-op when already set', () => {
    const root = project();
    writeFileSync(join(root, 'openspec', 'config.yaml'), 'schema: x\n');
    expect(setProjectSchema(root, 'x')).toBe(false);
  });
});
