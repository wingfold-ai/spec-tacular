/**
 * Defect changes: fixing something, rather than building it.
 *
 * A bug fix used to be an ordinary change, with a proposal and specs it did
 * not fit, or work done outside the tool, where the accepted specs quietly
 * stopped describing the system. Safety engineering's finding is that most
 * defects trace to an ambiguous or missing requirement rather than a coding
 * slip, and that every fix must say which: a code bug is fixed against the
 * unchanged requirement, a requirement bug changes the requirement first
 * (docs/proposals/add-defect-changes.md).
 *
 * A defect change uses its own schema, `spec-tacular-defect`, with the same
 * artifact ids, so every gate, review and evidence rule applies unchanged.
 * What is particular to it is checked here: the report says whose bug it is,
 * the specs agree with that answer, and there is a reproducer.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFECT_SCHEMA_NAME } from './init.ts';
import { parseSpecFile, type Requirement } from './requirements.ts';
import { guardTasks } from './risks.ts';

export type Fault = 'code' | 'requirement' | 'gap';
const FAULTS: readonly Fault[] = ['code', 'requirement', 'gap'];

export interface DefectReport {
  /** Whose bug it is, or null when the report does not say. */
  fault: Fault | null;
  /** `capability#slug` of the requirement the defect violates, when named. */
  violated: string | null;
}

export function isDefectSchema(schema: string): boolean {
  return schema === DEFECT_SCHEMA_NAME;
}

export function parseReport(content: string): DefectReport {
  const fault = content.match(/\*\*Whose bug:\*\*\s*([A-Za-z]+)/i)?.[1]?.toLowerCase();
  const violated = content.match(/\*\*Violated requirement:\*\*\s*`?([^\s`]+#[^\s`]+)`?/i)?.[1] ?? null;
  return { fault: FAULTS.includes(fault as Fault) ? (fault as Fault) : null, violated };
}

/** The same requirement in the accepted baseline, if it is there. */
function baselineOf(projectRoot: string, requirement: Requirement): Requirement | null {
  const file = join(projectRoot, 'openspec', 'specs', requirement.capability, 'spec.md');
  if (!existsSync(file)) return null;
  try {
    return parseSpecFile(readFileSync(file, 'utf8'), requirement.capability, file).requirements.find((r) => r.id === requirement.id) ?? null;
  } catch {
    return null;
  }
}

/** A requirement as the spec states it: everything but where it sits. */
const statement = (r: Requirement) =>
  [r.text, ...r.scenarios.flatMap((s) => [s.name, ...s.body])].join('\n').replace(/\s+/g, ' ').trim();

export interface DefectCheck {
  report: DefectReport;
  /** What does not fit the report's answer, worded for the overview. */
  warnings: string[];
}

/**
 * Whether the change agrees with its own report.
 *
 * - A code bug changes no requirement: its spec repeats the violated one,
 *   unchanged, for a person to confirm. A changed or added requirement means
 *   the report misjudged it.
 * - A requirement bug changes a requirement; a gap adds one. A spec that
 *   only repeats the baseline means the fix has nothing new to be measured
 *   against.
 * - Every fix has a reproducer: a guard task, whose test fails first.
 */
export function checkDefect(
  projectRoot: string,
  report: DefectReport,
  requirements: Requirement[],
  tasks: string | null,
): DefectCheck {
  const warnings: string[] = [];
  if (!report.fault) {
    warnings.push('the report does not say whose bug it is: **Whose bug:** code, requirement or gap');
  }

  const changed = requirements.filter((r) => {
    if (r.operation === 'ADDED' || r.operation === 'RENAMED') return true;
    if (r.operation !== 'MODIFIED') return false;
    const base = baselineOf(projectRoot, r);
    return !base || statement(base) !== statement(r);
  });

  if (report.fault === 'code' && changed.length > 0) {
    warnings.push(
      `a code bug changes no requirement, but this one changes ${changed.map((r) => `"${r.name}"`).join(', ')} — ` +
        'is it a requirement bug?',
    );
  }
  if ((report.fault === 'requirement' || report.fault === 'gap') && requirements.length > 0 && changed.length === 0) {
    warnings.push(`a ${report.fault === 'gap' ? 'gap adds' : 'requirement bug changes'} a requirement, but the specs only repeat the accepted ones`);
  }
  if (report.fault === 'code' && report.violated && requirements.length > 0 && !requirements.some((r) => r.id === report.violated)) {
    warnings.push(`the report names ${report.violated} as violated, but the specs do not include it`);
  }

  if (tasks !== null && guardTasks(tasks).length === 0) {
    warnings.push('no reproducer: the first task is a guard task whose test fails on the unfixed code');
  }
  return { report, warnings };
}
