/**
 * What the review shows of a formal form: its reading, its problems, and the
 * test matrix it gives — the most readable form of the formula. A reviewer
 * who disagrees with one row has found a wrong formula.
 *
 * Its own module because the matrix generator builds on core/formal/formal.ts.
 */

import type { ReviewItem } from '../requirements.ts';
import { formalOf, formalView, type FormalView } from './formal.ts';
import type { Glossary } from './glossary.ts';
import { matricesFor, matrixLines } from './matrix.ts';

export function reviewView(item: ReviewItem, glossary: Glossary | null): FormalView | null {
  const view = formalView(item, glossary);
  const form = formalOf(item);
  if (!view || !form || view.errors.length > 0) return view;
  const matrix = matricesFor(item, '', form, glossary).flatMap((m) => matrixLines(m));
  return matrix.length > 0 ? { ...view, matrix } : view;
}
