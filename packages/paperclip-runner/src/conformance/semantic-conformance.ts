export type SemanticConformanceAuthorization =
  | { readonly outcome: "allowed" }
  | { readonly outcome: "denied"; readonly code: string };

export interface SemanticConformanceVector {
  readonly id: string;
  readonly operationId: string;
  readonly input: unknown;
}

export interface SemanticConformanceObservation {
  readonly authorization: SemanticConformanceAuthorization;
  readonly state: unknown;
  readonly effects: readonly unknown[];
  readonly audit: readonly unknown[];
}

export interface SemanticConformanceAdapter {
  readonly id: string;
  execute(vector: SemanticConformanceVector): Promise<SemanticConformanceObservation>;
}

export interface SemanticConformanceReportRow {
  readonly vectorId: string;
  readonly operationId: string;
  readonly adapterIds: readonly string[];
  readonly observation: SemanticConformanceObservation;
}

export interface SemanticConformanceReport {
  readonly schema: "paperclip.semantic-conformance-report.v1";
  readonly rows: readonly SemanticConformanceReportRow[];
}

export class SemanticConformanceMismatchError extends Error {
  readonly code = "semantic_conformance_mismatch" as const;

  constructor(
    readonly vectorId: string,
    readonly baselineAdapterId: string,
    readonly mismatchedAdapterId: string,
  ) {
    super(
      `Semantic conformance mismatch for ${vectorId}: ${mismatchedAdapterId} differs from ${baselineAdapterId}`,
    );
    this.name = "SemanticConformanceMismatchError";
  }
}

/**
 * Executes provider-neutral command vectors against two or more adapters and
 * compares their normalized authorization, state, effects, and audit output.
 * Adapters own setup/teardown and normalization; this package owns comparison.
 */
export async function runSemanticConformanceKit(input: {
  readonly vectors: readonly SemanticConformanceVector[];
  readonly adapters: readonly SemanticConformanceAdapter[];
}): Promise<SemanticConformanceReport> {
  if (input.adapters.length < 2) {
    throw new Error("semantic_conformance_requires_two_adapters");
  }
  const rows: SemanticConformanceReportRow[] = [];
  for (const vector of input.vectors) {
    const observations = await Promise.all(
      input.adapters.map(async (adapter) => ({
        adapter,
        observation: await adapter.execute(vector),
      })),
    );
    const baseline = observations[0]!;
    const baselineJson = canonicalJson(baseline.observation);
    for (const candidate of observations.slice(1)) {
      if (canonicalJson(candidate.observation) !== baselineJson) {
        throw new SemanticConformanceMismatchError(
          vector.id,
          baseline.adapter.id,
          candidate.adapter.id,
        );
      }
    }
    rows.push(Object.freeze({
      vectorId: vector.id,
      operationId: vector.operationId,
      adapterIds: Object.freeze(input.adapters.map((adapter) => adapter.id)),
      observation: structuredClone(baseline.observation),
    }));
  }
  return Object.freeze({
    schema: "paperclip.semantic-conformance-report.v1",
    rows: Object.freeze(rows),
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
