/**
 * A line diff, for showing what a revision changes before it is accepted.
 *
 * Requirements are a few dozen lines at most, so the plain longest-common-
 * subsequence table is fast enough and gives the diff a reader expects.
 */

export type DiffOp = ' ' | '-' | '+';

export interface DiffLine {
  op: DiffOp;
  text: string;
}

export function lineDiff(before: string[], after: string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;
  // lcs[i][j]: the common subsequence length of before[i..] and after[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ op: ' ', text: before[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ op: '-', text: before[i++]! });
    } else {
      out.push({ op: '+', text: after[j++]! });
    }
  }
  while (i < n) out.push({ op: '-', text: before[i++]! });
  while (j < m) out.push({ op: '+', text: after[j++]! });
  return out;
}
