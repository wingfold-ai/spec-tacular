/**
 * Which OpenSpec versions spec-tacular works with.
 *
 * spec-tacular drives the OpenSpec CLI and reads its JSON, so the range is
 * what CI runs the real CLI against (`test/openspec-cli.test.ts`, once per
 * version in the `openspec` matrix of `.github/workflows/ci.yml`). Older than
 * the minimum is refused with how to update; a major newer than the last one
 * tested still runs, with a warning, because OpenSpec's majors so far changed
 * where agents find their skills, not the workflow spec-tacular uses.
 */

/** The oldest OpenSpec spec-tacular runs on: `status --all --json`, which the overview reads, arrived in 1.11. */
export const MIN_OPENSPEC = '1.11.0';

/** The newest major CI tests against. */
export const LATEST_TESTED_MAJOR = 2;

export type OpenSpecVersionCheck =
  | { ok: true; version: string; warning?: string }
  | { ok: false; version: string | null; problem: string };

const UPDATE = 'Update it: `npm i -g @fission-ai/openspec@latest`, or see https://openspec.dev.';

/** `1.14.0` out of whatever `openspec --version` printed. */
export function parseVersion(raw: string): [number, number, number] | null {
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function below(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

export function checkOpenSpecVersion(raw: string): OpenSpecVersionCheck {
  const v = parseVersion(raw);
  if (!v) {
    return { ok: false, version: null, problem: `Could not read the OpenSpec version from \`openspec --version\` (${raw.trim().slice(0, 60) || 'no output'}).` };
  }
  const version = v.join('.');
  if (below(v, parseVersion(MIN_OPENSPEC)!)) {
    return { ok: false, version, problem: `OpenSpec ${version} is too old: spec-tacular needs ${MIN_OPENSPEC} or newer. ${UPDATE}` };
  }
  if (v[0] > LATEST_TESTED_MAJOR) {
    return {
      ok: true,
      version,
      warning: `OpenSpec ${version} is newer than spec-tacular has been tested with (up to ${LATEST_TESTED_MAJOR}.x). If something does not work, update spec-tacular or report it.`,
    };
  }
  return { ok: true, version };
}
