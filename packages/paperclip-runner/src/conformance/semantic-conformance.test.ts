import { describe, expect, it } from "vitest";

import {
  SemanticConformanceMismatchError,
  runSemanticConformanceKit,
  type SemanticConformanceAdapter,
  type SemanticConformanceObservation,
} from "./semantic-conformance.js";

const allowed: SemanticConformanceObservation = {
  authorization: { outcome: "allowed" },
  state: { task: { status: "done" } },
  effects: [{ kind: "issue_status", status: "done" }],
  audit: [{ action: "finish_task" }],
};

function adapter(id: string, observation: SemanticConformanceObservation): SemanticConformanceAdapter {
  return { id, execute: async () => structuredClone(observation) };
}

describe("semantic conformance kit", () => {
  it("accepts normalized mock/real observations independent of object key order", async () => {
    const report = await runSemanticConformanceKit({
      vectors: [{ id: "finish", operationId: "finish_task", input: { summary: "done" } }],
      adapters: [
        adapter("mock", allowed),
        adapter("real", {
          audit: [{ action: "finish_task" }],
          effects: [{ status: "done", kind: "issue_status" }],
          state: { task: { status: "done" } },
          authorization: { outcome: "allowed" },
        }),
      ],
    });
    expect(report.schema).toBe("paperclip.semantic-conformance-report.v1");
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.adapterIds).toEqual(["mock", "real"]);
  });

  it("fails explicitly when a provider/control-plane adapter diverges", async () => {
    await expect(runSemanticConformanceKit({
      vectors: [{ id: "finish", operationId: "finish_task", input: {} }],
      adapters: [
        adapter("mock", allowed),
        adapter("real", { ...allowed, authorization: { outcome: "denied", code: "forbidden" } }),
      ],
    })).rejects.toBeInstanceOf(SemanticConformanceMismatchError);
  });
});
