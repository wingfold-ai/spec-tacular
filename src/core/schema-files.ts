/**
 * The spec-tacular schema's files, embedded in the program.
 *
 * Imported as text rather than read from `schemas/` at run time: a compiled
 * `spec-tacular` binary has no package directory next to it, so a path
 * relative to this module points nowhere. The bundler inlines these strings,
 * and `bun run` reads them from disk, so both behave the same.
 *
 * A file added under `schemas/spec-tacular/` must be listed here too;
 * test/init.test.ts fails until it is.
 */

import schema from '../../schemas/spec-tacular/schema.yaml' with { type: 'text' };
import design from '../../schemas/spec-tacular/templates/design.md' with { type: 'text' };
import proposal from '../../schemas/spec-tacular/templates/proposal.md' with { type: 'text' };
import spec from '../../schemas/spec-tacular/templates/spec.md' with { type: 'text' };
import tasks from '../../schemas/spec-tacular/templates/tasks.md' with { type: 'text' };

/** Path relative to the schema directory → file contents. */
export const SCHEMA_FILES: Readonly<Record<string, string>> = {
  'schema.yaml': schema as string,
  'templates/design.md': design,
  'templates/proposal.md': proposal,
  'templates/spec.md': spec,
  'templates/tasks.md': tasks,
};
