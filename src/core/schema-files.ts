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
import risks from '../../schemas/spec-tacular/templates/risks.md' with { type: 'text' };
import spec from '../../schemas/spec-tacular/templates/spec.md' with { type: 'text' };
import tasks from '../../schemas/spec-tacular/templates/tasks.md' with { type: 'text' };

/** Path relative to the schema directory → file contents. */
export const SCHEMA_FILES: Readonly<Record<string, string>> = {
  'schema.yaml': schema as string,
  'templates/design.md': design,
  'templates/proposal.md': proposal,
  'templates/risks.md': risks,
  'templates/spec.md': spec,
  'templates/tasks.md': tasks,
};

import defectSchema from '../../schemas/spec-tacular-defect/schema.yaml' with { type: 'text' };
import defectDesign from '../../schemas/spec-tacular-defect/templates/design.md' with { type: 'text' };
import defectProposal from '../../schemas/spec-tacular-defect/templates/proposal.md' with { type: 'text' };
import defectRisks from '../../schemas/spec-tacular-defect/templates/risks.md' with { type: 'text' };
import defectSpec from '../../schemas/spec-tacular-defect/templates/spec.md' with { type: 'text' };
import defectTasks from '../../schemas/spec-tacular-defect/templates/tasks.md' with { type: 'text' };

/**
 * The defect schema's files: a fix is a change of its own kind, chosen per
 * change (`openspec new change --schema`), installed next to the main one.
 */
export const DEFECT_SCHEMA_FILES: Readonly<Record<string, string>> = {
  'schema.yaml': defectSchema as string,
  'templates/design.md': defectDesign,
  'templates/proposal.md': defectProposal,
  'templates/risks.md': defectRisks,
  'templates/spec.md': defectSpec,
  'templates/tasks.md': defectTasks,
};
