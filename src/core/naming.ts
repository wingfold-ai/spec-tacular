/**
 * Names for a new change, proposed from what it is meant to do.
 *
 * Asking for a kebab-case name before anything else puts the hardest, least
 * important question first. The description comes first instead; a name is
 * proposed from it — instantly from its words, then better from a model — and
 * the developer adjusts it.
 */

import { validateChangeName } from './guide.ts';

/** Words that carry no meaning in a change name. */
const FILLER = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'to', 'of', 'for', 'in', 'on', 'at', 'by', 'with',
  'from', 'as', 'is', 'are', 'be', 'it', 'its', 'this', 'that', 'we', 'i', 'our', 'my',
  'so', 'can', 'should', 'will', 'want', 'need', 'let', 'lets', 'users', 'user', 'able',
  'into', 'when', 'which', 'their', 'them', 'they', 'have', 'has', 'new', 'also', 'more',
]);

/**
 * A name from the description's own words, with no model: the fallback, and
 * what is shown while a better one is on its way.
 */
export function nameFromDescription(description: string, taken: string[] = []): string {
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length > 1 && !FILLER.has(w));
  const base = words.slice(0, 4).join('-') || 'new-change';
  return unique(base, taken);
}

/** `name`, or `name-2`, `name-3`… when it is taken. */
export function unique(name: string, taken: string[]): string {
  if (!taken.includes(name)) return name;
  for (let i = 2; ; i++) if (!taken.includes(`${name}-${i}`)) return `${name}-${i}`;
}

export const NAME_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    alternatives: { type: 'array', items: { type: 'string' } },
  },
  required: ['name', 'alternatives'],
} as const;

export function buildNamePrompt(description: string, taken: string[]): string {
  return [
    'Name a change in a spec-driven project. The name is a directory name and how',
    'the team will refer to the change: kebab-case, lowercase, 2 to 4 words, verb',
    'first where natural (add-user-login, fix-export-timeout, migrate-to-postgres).',
    '',
    `The change: ${description}`,
    ...(taken.length > 0 ? ['', `Already taken: ${taken.join(', ')}`] : []),
    '',
    'Return the best name and 2 alternatives.',
  ].join('\n');
}

/** Only names OpenSpec would accept, not already taken, best first. */
export function parseNames(raw: unknown, taken: string[]): string[] {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const all = [record['name'], ...(Array.isArray(record['alternatives']) ? record['alternatives'] : [])];
  const names = all
    .map((n) => String(n ?? '').trim().toLowerCase())
    .filter((n) => validateChangeName(n) === null && !taken.includes(n));
  return [...new Set(names)];
}
