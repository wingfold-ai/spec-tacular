/**
 * JSON from an agent that cannot be made to answer in it.
 *
 * Claude Code enforces a schema itself. An agent that does not is asked for
 * JSON in the prompt, and what comes back is prose around a JSON object as
 * often as it is the object alone — fenced, prefixed with "Here you go", or
 * followed by a closing remark. This finds the object and checks it has the
 * shape asked for, so a malformed reply is caught here and retried rather
 * than turning into empty advice downstream.
 */

/** A reply that held no usable JSON; worth one retry with the reason. */
export class MalformedOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedOutputError';
  }
}

/** Every balanced `{…}` in `text`, in order, braces inside strings ignored. */
function objectsIn(text: string): string[] {
  const found: string[] = [];
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === '\\') i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        found.push(text.slice(start, i + 1));
        break;
      }
    }
  }
  return found;
}

/**
 * The JSON object in a reply: the whole reply, a fenced block, or the first
 * balanced object in the prose that parses and — given a schema — fits it.
 */
export function extractJson(text: string, schema?: object): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const candidates = [text.trim(), ...fenced, ...objectsIn(text)];
  let firstError: string | null = null;
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const problem = schema ? shapeError(value, schema) : null;
    if (!problem) return value;
    firstError ??= problem;
  }
  throw new MalformedOutputError(firstError ?? 'the reply held no JSON object');
}

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: readonly string[];
  items?: Schema;
};

/**
 * Why `value` does not fit `schema`, or null when it does.
 *
 * Only what the advisor's schemas use — types, required properties, array
 * items — which is all that decides whether a reply can be read at all.
 */
export function shapeError(value: unknown, schema: object, path = '$'): string | null {
  const s = schema as Schema;
  switch (s.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path} should be an object`;
      const record = value as Record<string, unknown>;
      for (const key of s.required ?? []) {
        if (!(key in record)) return `${path}.${key} is missing`;
      }
      for (const [key, sub] of Object.entries(s.properties ?? {})) {
        if (key in record) {
          const problem = shapeError(record[key], sub, `${path}.${key}`);
          if (problem) return problem;
        }
      }
      return null;
    }
    case 'array': {
      if (!Array.isArray(value)) return `${path} should be an array`;
      for (let i = 0; i < value.length; i++) {
        const problem = s.items ? shapeError(value[i], s.items, `${path}[${i}]`) : null;
        if (problem) return problem;
      }
      return null;
    }
    case 'string':
      return typeof value === 'string' ? null : `${path} should be a string`;
    case 'number':
    case 'integer':
      return typeof value === 'number' ? null : `${path} should be a number`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path} should be true or false`;
    default:
      return null;
  }
}

/** Asks for JSON in words, for an agent that cannot be given a schema. */
export function jsonInstruction(schema: object): string {
  return [
    'Answer with a single JSON object and nothing else — no prose before or after',
    'it, no code fence. It must match this JSON Schema:',
    JSON.stringify(schema),
  ].join('\n');
}

/** The follow-up that asks a model to fix a reply that did not fit. */
export function retryInstruction(problem: string): string {
  return [
    `Your last reply could not be used: ${problem}.`,
    'Reply again with only the corrected JSON object.',
  ].join('\n');
}
