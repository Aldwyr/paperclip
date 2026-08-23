import { describe, expect, it } from "vitest";

import { SSH_COMMAND_OUTPUT_MAX_BUFFER_BYTES } from "./execution-target.js";
import { DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES } from "./sandbox-callback-bridge.js";

describe("SSH command output buffer", () => {
  it("pins the SSH output buffer at 1 MiB", () => {
    expect(SSH_COMMAND_OUTPUT_MAX_BUFFER_BYTES).toBe(1024 * 1024);
  });

  it("keeps the SSH output buffer decoupled from the bridge body cap", () => {
    // The SSH output buffer once tracked the bridge body cap (cap * 4). At a
    // 10 MiB bridge cap that coupling would push the SSH buffer to about 40 MiB
    // per stream. The SSH buffer must stay pinned and must not move with the
    // bridge cap.
    expect(SSH_COMMAND_OUTPUT_MAX_BUFFER_BYTES).not.toBe(
      DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES * 4,
    );
    expect(SSH_COMMAND_OUTPUT_MAX_BUFFER_BYTES).toBeLessThan(
      DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES,
    );
  });
});
