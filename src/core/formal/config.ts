/**
 * `matrix:` in `spec-tacular/verification.yaml`: where the matrix tests and
 * their harnesses live, and how the harness check runs them. Defaults are for
 * a bun project; every key can be set.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export interface MatrixConfig {
  /** Where the runner is copied to. */
  runner: string;
  /** Where the generated test files go. */
  tests: string;
  /** Where the harnesses are, one per component. */
  harness: string;
  /** The module the generated tests take `test` from. */
  testImport: string;
  /** Runs the given test files; `{tests}` is replaced by them. */
  run: string;
  /** The same with coverage, writing an lcov report. */
  coverage: string;
  /** Where that lcov report is. */
  lcov: string;
  /** At most this many mutants per harness check. */
  mutants: number;
  /** The share of mutants the matrix must kill, 0 to 1. */
  mutationThreshold: number;
  /** Files and directories never mutated: generated code, test doubles kept elsewhere. */
  exclude: string[];
  /**
   * When formal forms are verified through generated matrices, a harness
   * and its mutation check: `auto` for changes in class P0 or P1 only,
   * `always`, or `never`. Otherwise a formal form still specifies — it is
   * read back, checked for conflicts, and its questions are asked — and its
   * requirement is tested like any other.
   */
  verify: 'auto' | 'always' | 'never';
}

/**
 * Whether a change in class `cls` verifies its formal forms through
 * matrices. On ordinary code the matrix, the harness and the mutation check
 * cost most of a change's extra time and caught little the tests did not;
 * they are for the code whose failure costs most.
 */
export function matrixVerified(cls: string | null, config: MatrixConfig): boolean {
  if (config.verify === 'always') return true;
  if (config.verify === 'never') return false;
  return cls === 'P0' || cls === 'P1';
}

export const DEFAULT_MATRIX_CONFIG: MatrixConfig = {
  runner: 'test/support/spec-tacular-matrix.ts',
  tests: 'test/matrix',
  harness: 'test/support/harness',
  testImport: 'bun:test',
  run: 'bun test {tests}',
  coverage: 'bun test --coverage --coverage-reporter=lcov --coverage-dir=.spec-tacular/coverage {tests}',
  lcov: '.spec-tacular/coverage/lcov.info',
  mutants: 32,
  mutationThreshold: 1,
  exclude: [],
  verify: 'auto',
};

export function matrixConfig(projectRoot: string): MatrixConfig {
  try {
    const raw = parse(readFileSync(join(projectRoot, 'spec-tacular', 'verification.yaml'), 'utf8')) as Record<string, unknown> | null;
    const m = (raw?.['matrix'] ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof m[k] === 'string' && (m[k] as string).trim() ? (m[k] as string).trim() : undefined);
    const num = (k: string) => (typeof m[k] === 'number' ? (m[k] as number) : undefined);
    const d = DEFAULT_MATRIX_CONFIG;
    return {
      runner: str('runner') ?? d.runner,
      tests: str('tests') ?? d.tests,
      harness: str('harness') ?? d.harness,
      testImport: str('test_import') ?? d.testImport,
      run: str('run') ?? d.run,
      coverage: str('coverage') ?? d.coverage,
      lcov: str('lcov') ?? d.lcov,
      mutants: num('mutants') ?? d.mutants,
      mutationThreshold: num('mutation_threshold') ?? d.mutationThreshold,
      verify: m['verify'] === 'always' || m['verify'] === 'never' ? m['verify'] : d.verify,
      exclude: Array.isArray(m['exclude']) ? (m['exclude'] as unknown[]).filter((x): x is string => typeof x === 'string') : d.exclude,
    };
  } catch {
    return DEFAULT_MATRIX_CONFIG;
  }
}
