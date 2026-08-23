import { describe, expect, it } from "vitest";
import {
  buildNativeCompletionContract,
  resolveNativeCompletionPolicy,
} from "./completion-contracts.js";

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

describe("resolveNativeCompletionPolicy", () => {
  it("uses agent claims for ordinary issues", () => {
    expect(resolveNativeCompletionPolicy({ reviewPolicy: null })).toEqual({
      risk: "low",
      completionAuthority: "agent_claim_policy",
    });
    expect(resolveNativeCompletionPolicy({ reviewPolicy: "anyone" })).toEqual({
      risk: "low",
      completionAuthority: "agent_claim_policy",
    });
  });

  it("keeps completion server-authoritative when issue policy requires review", () => {
    for (const reviewPolicy of ["human_only", "not_creator"]) {
      expect(resolveNativeCompletionPolicy({ reviewPolicy })).toEqual({
        risk: "standard",
        completionAuthority: "server_arbiter",
      });
    }
  });
});
