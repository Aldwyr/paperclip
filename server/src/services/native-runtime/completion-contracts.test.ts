import { describe, expect, it } from "vitest";
import { buildNativeCompletionContract } from "./completion-contracts.js";

describe("buildNativeCompletionContract", () => {
  it("uses the issue description for an assignment", () => {
    expect(buildNativeCompletionContract({
      title: "Original task",
      description: "Return the original result.",
    })).toEqual({
      revision: "1",
      objective: "Original task",
      criteria: [{ id: "objective", requirement: "Return the original result." }],
    });
  });

  it("makes the latest comment authoritative for a follow-up run", () => {
    expect(buildNativeCompletionContract(
      { title: "Original task", description: "Return the original result." },
      " Return the follow-up result. ",
    )).toEqual({
      revision: "1",
      objective: "Respond to the latest comment on Original task",
      criteria: [{ id: "objective", requirement: "Return the follow-up result." }],
    });
  });
});
