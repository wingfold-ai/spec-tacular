/**
 * The roadmap: a vision decomposed into an ordered list of slices.
 *
 * OpenSpec's model is a *change* against an existing baseline — its README
 * says so. On day one there is no baseline, so a vision decomposes into a
 * dozen parallel changes with no sequencing, and every one needs full review
 * before any code exists (docs/problem-analysis.md §4).
 *
 * The roadmap is reviewed first, cheaply: one line per slice. Changes then
 * open one slice at a time, so the review queue never exceeds one change:
 * the next slice opens once the one before it is specified, so what it does
 * can be settled while that one is designed and built — but its own design,
 * tasks and implementing wait until the code before it exists.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';

export type SliceStatus = 'planned' | 'active' | 'done';

export interface Slice {
  id: string;
  summary: string;
  status: SliceStatus;
  /** Slice ids that must be done first. */
  dependsOn: string[];
}

export interface Roadmap {
  vision: string;
  slices: Slice[];
}

export function roadmapPath(projectRoot: string): string {
  return join(projectRoot, 'spec-tacular', 'roadmap.yaml');
}

export function roadmapExists(projectRoot: string): boolean {
  return existsSync(roadmapPath(projectRoot));
}

const STATUSES: SliceStatus[] = ['planned', 'active', 'done'];

function toSlice(raw: unknown): Slice | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r['id'] === 'string' ? r['id'].trim() : '';
  if (!id) return null;

  const status = typeof r['status'] === 'string' ? r['status'].trim() : '';
  return {
    id,
    summary: typeof r['summary'] === 'string' ? r['summary'].trim() : '',
    // An unrecognised status reads as `planned`: the safe reading is that the
    // slice has not started, never that it is finished.
    status: STATUSES.includes(status as SliceStatus) ? (status as SliceStatus) : 'planned',
    dependsOn: Array.isArray(r['dependsOn'])
      ? r['dependsOn'].filter((d): d is string => typeof d === 'string')
      : [],
  };
}

export function loadRoadmap(projectRoot: string): Roadmap | null {
  const path = roadmapPath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const raw = parse(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
    if (!raw) return { vision: '', slices: [] };
    const slices = Array.isArray(raw['slices'])
      ? raw['slices'].map(toSlice).filter((s): s is Slice => s !== null)
      : [];
    return { vision: typeof raw['vision'] === 'string' ? raw['vision'] : '', slices };
  } catch {
    // A broken roadmap must not stop the rest of the tool working.
    return null;
  }
}

export function saveRoadmap(projectRoot: string, roadmap: Roadmap): void {
  const path = roadmapPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(roadmap, { lineWidth: 80 }), 'utf8');
}

export const ROADMAP_TEMPLATE: Roadmap = {
  vision: 'TBD — one paragraph on what this project is for.',
  slices: [
    {
      id: 'first-slice',
      summary: 'TBD — one line on what a user can do once this lands.',
      status: 'planned',
      dependsOn: [],
    },
  ],
};

export function scaffoldRoadmap(projectRoot: string): boolean {
  if (roadmapExists(projectRoot)) return false;
  saveRoadmap(projectRoot, ROADMAP_TEMPLATE);
  return true;
}

export type PromoteSliceResult =
  | { ok: true; slice: Slice; roadmap: Roadmap }
  | { ok: false; reason: string };

/**
 * Whether an active slice's change is specified: its proposal and specs
 * accepted. What it does is settled; how it is built comes later.
 */
export type IsSpecified = (sliceId: string) => boolean;

/**
 * Marks a slice active, so a change can be opened for it.
 *
 * One slice being specified at a time. That single rule is what stops a
 * greenfield project turning into a dozen changes nobody can review: the queue
 * is bounded by construction rather than by discipline. A specified slice no
 * longer holds the queue — the next one may be specified while it is designed
 * and built — and counts as far enough along for the slices that depend on
 * it: their design, tasks and implementing still wait for it (`waitingOn`).
 */
export function promoteSlice(roadmap: Roadmap, id: string, specified: IsSpecified = () => false): PromoteSliceResult {
  const slice = roadmap.slices.find((s) => s.id === id);
  if (!slice) return { ok: false, reason: `no slice called '${id}'` };
  if (slice.status === 'done') return { ok: false, reason: `'${id}' is already done` };
  if (slice.status === 'active') return { ok: false, reason: `'${id}' is already active` };

  const planning = roadmap.slices.find((s) => s.status === 'active' && !specified(s.id));
  if (planning) {
    return {
      ok: false,
      reason:
        `'${planning.id}' is still being specified. Accept its specs first — one slice ` +
        'specified at a time is what keeps the review queue to a single change.',
    };
  }

  const blocking = slice.dependsOn.filter((dep) => {
    const other = roadmap.slices.find((s) => s.id === dep);
    // A dependency that does not exist is a broken roadmap, and treating it as
    // satisfied would let the slice through on a typo.
    return !other || !(other.status === 'done' || (other.status === 'active' && specified(other.id)));
  });
  if (blocking.length > 0) {
    return { ok: false, reason: `'${id}' depends on ${blocking.join(', ')}, not done yet` };
  }

  const updated: Roadmap = {
    ...roadmap,
    slices: roadmap.slices.map((s) => (s.id === id ? { ...s, status: 'active' as const } : s)),
  };
  return { ok: true, slice: { ...slice, status: 'active' }, roadmap: updated };
}

/** Marks a slice done, freeing the next one to be promoted. */
export function completeSlice(roadmap: Roadmap, id: string): PromoteSliceResult {
  const slice = roadmap.slices.find((s) => s.id === id);
  if (!slice) return { ok: false, reason: `no slice called '${id}'` };
  const updated: Roadmap = {
    ...roadmap,
    slices: roadmap.slices.map((s) => (s.id === id ? { ...s, status: 'done' as const } : s)),
  };
  return { ok: true, slice: { ...slice, status: 'done' }, roadmap: updated };
}

/** The next slice that could be promoted, or null when none can be. */
export function nextPromotable(roadmap: Roadmap, specified: IsSpecified = () => false): Slice | null {
  return roadmap.slices.find((s) => s.status === 'planned' && promoteSlice(roadmap, s.id, specified).ok) ?? null;
}

/**
 * The slices before `id` on the roadmap that are not done yet: what its
 * design, tasks and implementing wait for. Empty for a change that is no slice.
 */
export function waitingOn(roadmap: Roadmap | null, id: string): string[] {
  const at = roadmap?.slices.findIndex((s) => s.id === id) ?? -1;
  if (!roadmap || at < 0) return [];
  return roadmap.slices.slice(0, at).filter((s) => s.status === 'active').map((s) => s.id);
}

/**
 * The roadmap with the slices whose changes are applied marked done, or null
 * when that changes nothing.
 */
export function markApplied(roadmap: Roadmap, applied: (sliceId: string) => boolean): Roadmap | null {
  let changed = false;
  const slices = roadmap.slices.map((s) => {
    if (s.status !== 'active' || !applied(s.id)) return s;
    changed = true;
    return { ...s, status: 'done' as const };
  });
  return changed ? { ...roadmap, slices } : null;
}
