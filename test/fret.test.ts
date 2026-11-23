import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { holdsAt, parseMtl } from '../src/core/formal/mtl.ts';
import { parseFretish } from '../src/core/formal/fretish.ts';
import {
  crossCheck,
  exportFiles,
  formulasPath,
  fretFormula,
  fretInvocation,
  monitorability,
  monitorDecision,
  monitorFret,
  readTrace,
} from '../src/core/formal/fret.ts';
import { readGlossary } from '../src/core/formal/glossary.ts';
import { parseExpr } from '../src/core/formal/expr.ts';

const dirs: string[] = [];
const project = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-fret-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env['SPECTACULAR_FRET_CLI'];
});

const steps = (values: Record<string, number[]>) => {
  const n = Math.max(...Object.values(values).map((v) => v.length));
  return Array.from({ length: n }, (_, i) => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v[i] === 1])));
};

/**
 * FRET's own output, from its CLI documentation
 * (fret-electron/docs/_media/cli/cli.md):
 *   formalize -l ft-fin 'sw shall within 500 ticks satisfy x'
 *   → ((F[0,500] x) | (F[0,499] LAST))
 */
const FRET_SENTENCE = 'sw shall within 500 ticks satisfy x';
const FRET_FORMULA = '((F[0,500] x) | (F[0,499] LAST))';

describe('FRET\'s finite-trace logic', () => {
  test('next is strong, LAST marks the end, bounds are inclusive', () => {
    const t = steps({ x: [0, 1, 0] });
    expect(holdsAt(parseMtl('X x'), t, 0)).toBe(true);
    expect(holdsAt(parseMtl('X x'), t, 2)).toBe(false); // no next step
    expect(holdsAt(parseMtl('F[0,1] x'), t, 0)).toBe(true);
    expect(holdsAt(parseMtl('F[2,2] x'), t, 0)).toBe(false);
    expect(holdsAt(parseMtl('F LAST'), t, 0)).toBe(true);
    expect(holdsAt(parseMtl('G (x -> X !x)'), t, 0)).toBe(true);
  });

  test('until and release', () => {
    const t = steps({ a: [1, 1, 0], b: [0, 0, 1] });
    expect(holdsAt(parseMtl('a U b'), t, 0)).toBe(true);
    expect(holdsAt(parseMtl('a U b'), steps({ a: [1, 0, 0], b: [0, 0, 1] }), 0)).toBe(false);
    // b V a: a holds until and including the first b, or to the end.
    expect(holdsAt(parseMtl('b V a'), steps({ a: [1, 1, 1], b: [0, 0, 0] }), 0)).toBe(true);
    expect(holdsAt(parseMtl('b V a'), steps({ a: [1, 0, 1], b: [0, 0, 0] }), 0)).toBe(false);
  });

  test('comparisons are atoms', () => {
    expect(holdsAt(parseMtl('G (voltage > 9)'), [{ voltage: 10 }, { voltage: 12 }], 0)).toBe(true);
    expect(holdsAt(parseMtl('G (voltage > 9)'), [{ voltage: 10 }, { voltage: 9 }], 0)).toBe(false);
  });
});

describe('cross-checking spec-tacular against FRET', () => {
  test('agrees with FRET\'s formula for "within", windows running past the end included', () => {
    const f = parseFretish(FRET_SENTENCE);
    const edges = [498, 499, 500, 501, 502].flatMap((len) =>
      [-1, 0, 499, 500, 501].map((at) => Array.from({ length: len }, (_, i) => ({ x: i === at }))),
    );
    const result = crossCheck(f, FRET_FORMULA, edges, 200);
    expect(result.disagreements).toEqual([]);
    expect(result.traces).toBe(225);
  });

  test('a reading that differs from FRET\'s is caught, with the trace', () => {
    // A naive reading of "within": the response must come, however short the run.
    const result = crossCheck(parseFretish('sw shall within 3 ticks satisfy x'), 'F[0,3] x');
    expect(result.disagreements.length).toBeGreaterThan(0);
    const d = result.disagreements[0]!;
    expect(d).toMatchObject({ fret: false, ours: true });
    expect(d.trace.length).toBeLessThanOrEqual(3); // ended before the window could close
  });

  test('formulas come from the FRET command line, and are cached for where it is not', () => {
    const d = project();
    // A stand-in for `fretcli`, printing FRET's documented answer.
    const cli = join(d, 'fretcli');
    writeFileSync(cli, `#!/bin/sh\necho '- Generating…'\necho '${FRET_FORMULA}'\n`);
    chmodSync(cli, 0o755);
    process.env['SPECTACULAR_FRET_CLI'] = cli;
    expect(fretFormula(d, FRET_SENTENCE)).toEqual({ formula: FRET_FORMULA, from: 'fret' });
    expect(JSON.parse(readFileSync(formulasPath(d), 'utf8'))[FRET_SENTENCE].ftFin).toBe(FRET_FORMULA);

    delete process.env['SPECTACULAR_FRET_CLI'];
    expect(fretFormula(d, FRET_SENTENCE)).toEqual({ formula: FRET_FORMULA, from: 'cache' });
    expect(fretFormula(d, 'sw shall satisfy y').formula).toBeNull();
  });

  test('arguments reach the FRET command line as they are, never as shell code', () => {
    const d = project();
    const marker = join(d, 'pwned');
    const hostile = [`it's'; touch ${marker}; echo '`, '$(touch ' + marker + ')', '`touch ' + marker + '`', 'a b', ''];
    const r = spawnSync(...fretInvocation(`printf '[%s]\\n' realizability`, hostile), { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(['realizability', ...hostile].map((a) => `[${a}]\n`).join(''));
    expect(existsSync(marker)).toBe(false);
  });
});

describe('export', () => {
  test('requirements as FRET reads them, variables in its kinds and types', () => {
    const g = readGlossary({
      variables: {
        req: { role: 'input', type: 'bool', meaning: 'a request goes out' },
        level: { role: 'output', type: 'float', meaning: 'tank level' },
        flight: { role: 'mode', type: 'bool', meaning: 'airborne' },
      },
    });
    const files = exportFiles('demo', [{ reqid: 'c:client#answer', fulltext: 'upon req Client shall within 3 ticks satisfy done', rationale: 'Answer, or time out.' }], g);
    expect(JSON.parse(files['fret-requirements.json']!)).toEqual([
      { reqid: 'c:client#answer', parent_reqid: '', project: 'demo', rationale: 'Answer, or time out.', comments: '', fulltext: 'upon req Client shall within 3 ticks satisfy done' },
    ]);
    expect(files['fret-variables.csv']).toBe('name,kind,type,description\nreq,Input,boolean,a request goes out\nlevel,Output,double,tank level\nflight,Mode,boolean,airborne\n');
  });
});

describe('monitoring', () => {
  test('an unbounded eventually cannot be monitored on a running system', () => {
    expect(monitorability(parseFretish('upon req Client shall eventually satisfy done'))).toContain('unbounded');
    expect(monitorability(parseFretish('in flight mode Pump shall eventually satisfy primed'))).toBeNull();
    expect(monitorability(parseFretish('upon req Client shall within 3 ticks satisfy done'))).toBeNull();
  });

  test('a recorded run is checked against FRETish and decisions', () => {
    const trace = readTrace('{"req":true,"done":false,"a":true,"b":true}\n{"req":false,"done":false,"a":true,"b":false}\n\n{"req":false,"done":true,"a":false,"b":false}\n');
    expect(monitorFret('Answer', parseFretish('upon req Client shall within 1 ticks satisfy done'), trace)).toMatchObject({ holds: false, violated: [0] });
    expect(monitorFret('Answer', parseFretish('upon req Client shall within 2 ticks satisfy done'), trace)).toMatchObject({ holds: true });
    const d = { output: 'b', expr: parseExpr('a & req'), source: 'b = a & req' };
    expect(monitorDecision('Both', d, trace, null)).toMatchObject({ holds: true, violated: [] });
    expect(monitorFret('X', parseFretish('upon go X shall satisfy y'), trace)).toMatchObject({ holds: null, unobserved: ['go', 'y'] });
  });

  test('a trace line that is not JSON is named', () => {
    expect(() => readTrace('{"a":true}\nnope\n')).toThrow('line 2 of the trace is not JSON');
  });
});
