import { describe, expect, it } from "vitest";

import {
  acpxBootstrapBlockedError,
  enqueueAcpxSidecarInput,
  recordAcpxBootstrapFailure,
} from "./acpx-sidecar-input.js";

describe("ACPX sidecar input sequencing", () => {
  it("drains initialize, session.open, and suspend in order before EOF shutdown", async () => {
    const events: string[] = [];
    let pending = Promise.resolve();
    for (const command of ["initialize", "session.open", "session.suspend"]) {
      pending = enqueueAcpxSidecarInput(
        pending,
        async () => {
          events.push(command);
        },
        () => events.push(`${command}:error`),
      );
    }
    const shutdown = pending.then(() => events.push("shutdown"));

    await shutdown;
    expect(events).toEqual(["initialize", "session.open", "session.suspend", "shutdown"]);
  });

  it("preserves the bootstrap failure and blocks dependent commands", () => {
    const rootCause = new Error("agent initialize exited");
    const failure = recordAcpxBootstrapFailure(null, "session.open", rootCause);

    expect(failure).toBe(rootCause);
    expect(acpxBootstrapBlockedError(failure, "session.suspend")?.message).toBe(
      "ACPX provider bootstrap failed before session.suspend: agent initialize exited",
    );
    expect(recordAcpxBootstrapFailure(failure, "session.suspend", new Error("secondary"))).toBe(
      rootCause,
    );
  });
});
