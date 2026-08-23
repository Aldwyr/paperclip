import { describe, expect, it } from "vitest";

import { selectAcpxFinalAgentMessage } from "./acpx-runtime-driver.js";

describe("ACPX settled final response", () => {
  it("uses the exact assistant prose present when the semantic result was accepted", () => {
    expect(selectAcpxFinalAgentMessage({
      semanticResultCommitted: true,
      textAtSemanticResult: "- First fact\n- Second fact",
      textAfterLastWorkTool: "- First fact\n- Second fact\nCompleted: task done.",
    })).toBe("- First fact\n- Second fact");
  });

  it("does not promote a trailing acknowledgement when the semantic boundary had no answer", () => {
    expect(selectAcpxFinalAgentMessage({
      semanticResultCommitted: true,
      textAtSemanticResult: null,
      textAfterLastWorkTool: "Completed.",
    })).toBeNull();
  });

  it("preserves a result-less provider final emitted after its last work tool", () => {
    expect(selectAcpxFinalAgentMessage({
      semanticResultCommitted: false,
      textAtSemanticResult: null,
      textAfterLastWorkTool: "  Substantive answer.  ",
    })).toBe("Substantive answer.");
  });
});
