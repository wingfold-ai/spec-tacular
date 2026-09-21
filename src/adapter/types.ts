/**
 * The shape of `openspec ... --json` output that spec-tacular relies on.
 *
 * These mirror OpenSpec's published CLI contract, not its internal modules —
 * the CLI's JSON surface is the more stable of the two. Fields spec-tacular
 * does not use are deliberately omitted; the parser ignores extras so an
 * upstream addition is never a breaking change.
 */

/** OpenSpec's per-artifact state. Derived purely from file existence. */
export type OpenSpecArtifactStatus = 'done' | 'ready' | 'blocked';

export interface OpenSpecArtifact {
  id: string;
  outputPath: string;
  status: OpenSpecArtifactStatus;
  requires: string[];
}

export interface OpenSpecArtifactPaths {
  outputPath: string;
  resolvedOutputPath: string;
  existingOutputPaths: string[];
}

export interface OpenSpecPlanningHome {
  kind: string;
  root: string;
  changesDir: string;
  defaultSchema: string;
}

export interface OpenSpecChangeStatus {
  changeName: string;
  schemaName: string;
  planningHome?: OpenSpecPlanningHome;
  changeRoot: string;
  artifactPaths: Record<string, OpenSpecArtifactPaths>;
  isPlanningComplete: boolean;
  applyRequires: string[];
  nextSteps: string[];
  artifacts: OpenSpecArtifact[];
}

/** `openspec status --all --json`. */
export interface OpenSpecBatchStatus {
  changes: OpenSpecChangeStatus[];
  root: { path: string } | null;
}

/**
 * A change that failed to load. OpenSpec's batch sweep does not abort on one
 * bad change — it emits a diagnostic entry in place of a status — so the
 * adapter must expect entries that carry no `artifacts`.
 */
export interface OpenSpecChangeError {
  changeName: string;
  status: unknown;
}

export function isChangeError(
  entry: OpenSpecChangeStatus | OpenSpecChangeError,
): entry is OpenSpecChangeError {
  return !Array.isArray((entry as OpenSpecChangeStatus).artifacts);
}
