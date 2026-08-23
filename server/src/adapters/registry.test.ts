import { describe, expect, it } from "vitest";
import { assertValidAdapterLoginCapability } from "@paperclipai/adapter-utils";
import { requireServerAdapter } from "./registry.js";

// The registry registers a login capability for the two built-in interactive
// adapters. The test checks the scalar values and the presence of the required
// callbacks. It also runs the shared validator, so the built-in capabilities
// obey the same fail-closed contract as an external adapter.

describe("built-in adapter login capabilities", () => {
  it("publishes the qualified OpenCode runner configuration", async () => {
    const adapter = requireServerAdapter("paperclip_runner");
    expect(adapter.models).toContainEqual({
      id: "openrouter/deepseek/deepseek-v4-flash-0731",
      label: "OpenRouter · DeepSeek V4 Flash 0731",
    });
    expect(adapter.getRuntimeCommandSpec?.({ provider: "opencode" }))
      .toMatchObject({ command: "opencode", installCommand: expect.stringContaining("opencode-ai@1.18.17") });
    const schema = await adapter.getConfigSchema?.();
    expect(schema?.fields.map((field) => field.key))
      .toEqual(expect.arrayContaining(["provider", "model", "command"]));
  });

  it("registers the Codex device-login capability", () => {
    const capability = requireServerAdapter("codex_local").loginCapability;
    expect(capability).toBeDefined();
    if (!capability) return;
    expect(capability.panelMode).toBe("displayed_code");
    expect(capability.timeoutPolicy).toBe("caller_bounded");
    expect(capability.completionClaim).toBeUndefined();
    expect(typeof capability.getCommand).toBe("function");
    expect(typeof capability.parsePrompt).toBe("function");
    expect(() => assertValidAdapterLoginCapability(capability, "codex_local")).not.toThrow();
  });

  it("registers the Claude setup-token capability", () => {
    const capability = requireServerAdapter("claude_local").loginCapability;
    expect(capability).toBeDefined();
    if (!capability) return;
    expect(capability.panelMode).toBe("submitted_browser_code");
    expect(capability.timeoutPolicy).toBe("fixed");
    expect(capability.completionClaim).toBe("storedSessionId");
    expect(typeof capability.getCommand).toBe("function");
    expect(typeof capability.parsePrompt).toBe("function");
    expect(typeof capability.captureCredential).toBe("function");
    expect(() => assertValidAdapterLoginCapability(capability, "claude_local")).not.toThrow();
  });
});
