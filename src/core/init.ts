/**
 * Installs spec-tacular's schema into an OpenSpec project.
 *
 * The schema is what enforces `proposal → specs → design → tasks` for anyone
 * running plain `openspec`, without spec-tacular in the loop
 * (docs/problem-analysis.md §1). Its one substantive change from `spec-driven`
 * is `design.requires: [specs]` instead of `[proposal]`; the rest is
 * instruction wording for abstraction, example marking and deferral.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffoldFoundation } from './foundation.ts';
import { isGreenfield } from './vision.ts';

export const SCHEMA_NAME = 'spec-tacular';

/** The schema shipped inside this package. */
export function bundledSchemaDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas', SCHEMA_NAME);
}

export interface InitResult {
  schemaDir: string;
  files: string[];
  /** True when an existing install was replaced. */
  replaced: boolean;
  configUpdated: boolean;
  /** Foundation documents written, and those left alone because they existed. */
  foundationCreated: string[];
  foundationSkipped: string[];
  notes: string[];
}

function copyTree(from: string, to: string, written: string[], base = to): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const src = join(from, entry);
    const dst = join(to, entry);
    if (statSync(src).isDirectory()) copyTree(src, dst, written, base);
    else {
      copyFileSync(src, dst);
      written.push(dst.slice(base.length + 1));
    }
  }
}

/**
 * Points the project's config at a schema.
 *
 * Rewrites only the `schema:` line, leaving `context:`, `rules:` and any
 * comments untouched — this file is hand-maintained and holds a project's
 * house rules, so replacing it wholesale would destroy real work.
 */
export function setProjectSchema(projectRoot: string, schema: string): boolean {
  const configPath = join(projectRoot, 'openspec', 'config.yaml');

  if (!existsSync(configPath)) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `schema: ${schema}\n`, 'utf8');
    return true;
  }

  const original = readFileSync(configPath, 'utf8');
  // Only a top-level `schema:` key — one nested under `rules:` or quoted
  // inside `context:` must not be touched.
  const line = /^schema:[ \t]*\S.*$/m;
  if (line.test(original)) {
    const updated = original.replace(line, `schema: ${schema}`);
    if (updated === original) return false;
    writeFileSync(configPath, updated, 'utf8');
    return true;
  }
  writeFileSync(configPath, `schema: ${schema}\n${original}`, 'utf8');
  return true;
}

export function initProject(
  projectRoot: string,
  options: { setSchema?: boolean } = {},
): InitResult {
  const source = bundledSchemaDir();
  if (!existsSync(source)) {
    throw new Error(`The bundled ${SCHEMA_NAME} schema is missing at ${source}`);
  }

  const schemaDir = join(projectRoot, 'openspec', 'schemas', SCHEMA_NAME);
  const replaced = existsSync(schemaDir);

  const files: string[] = [];
  copyTree(source, schemaDir, files);

  const notes: string[] = [];
  if (replaced) {
    notes.push(
      `Replaced the existing ${SCHEMA_NAME} schema. Local edits to it are gone;` +
        ' fork it under another name to keep your own.',
    );
  }

  // A new project has no code to answer some questions from yet: those are
  // left for later rather than asked (core/foundation.ts).
  const foundation = scaffoldFoundation(projectRoot, { defer: isGreenfield(projectRoot) });
  if (foundation.created.length > 0) {
    notes.push(
      'Answer the Foundation questions before proposing a change. Every one is' +
        ' left as TBD on purpose: a default nobody chose is indistinguishable' +
        ' from a decision.',
    );
  }

  const configUpdated = options.setSchema === false ? false : setProjectSchema(projectRoot, SCHEMA_NAME);
  if (configUpdated) {
    // Existing changes pin their schema in their own .openspec.yaml, so this
    // affects new changes only. Saying so avoids the assumption that it
    // retroactively re-sequences work already in flight.
    notes.push('New changes will use this schema. Changes already in flight keep theirs.');
  }

  return {
    schemaDir,
    files: files.sort(),
    replaced,
    configUpdated,
    foundationCreated: foundation.created,
    foundationSkipped: foundation.skipped,
    notes,
  };
}
