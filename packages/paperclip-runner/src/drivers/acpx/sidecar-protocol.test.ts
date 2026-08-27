import { describe, expect, it } from "vitest";

import { sanitizeAcpxPlanEntries } from "./sidecar-protocol.js";

describe("ACPX sidecar structured plans", () => {
  it("preserves every valid ordered entry while bounding and sanitizing the snapshot", () => {
    const entries = sanitizeAcpxPlanEntries([
      { content: " Inspect ", status: "completed", priority: "high" },
      { content: "Implement", status: "in_progress", priority: "medium" },
      { content: "Verify", status: "pending", priority: "low" },
      { content: "Invalid status", status: "failed" },
      { content: "   ", status: "pending" },
      { content: "x".repeat(5_000), status: "pending", priority: "p".repeat(100) },
    ]);

    expect(entries.slice(0, 3)).toEqual([
      { content: "Inspect", status: "completed", priority: "high" },
      { content: "Implement", status: "in_progress", priority: "medium" },
      { content: "Verify", status: "pending", priority: "low" },
    ]);
    expect(entries).toHaveLength(4);
    expect(entries[3]?.content).toHaveLength(4_000);
    expect(entries[3]?.priority).toHaveLength(80);
    expect(sanitizeAcpxPlanEntries(Array.from({ length: 300 }, (_, index) => ({
      content: `Step ${index}`,
      status: "pending",
    })))).toHaveLength(256);
  });
});
