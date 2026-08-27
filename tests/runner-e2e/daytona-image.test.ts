import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

describe("runner E2E Daytona image contract", () => {
  it("builds runnerd and the provider pack and verifies every required transport", async () => {
    const [dockerfile, workflow] = await Promise.all([
      readFile(
        path.join(repositoryRoot, "docker/daytona-runner/Dockerfile"),
        "utf8",
      ),
      readFile(
        path.join(
          repositoryRoot,
          ".github/workflows/runner-full-stack-e2e.yml",
        ),
        "utf8",
      ),
    ]);
    expect(dockerfile).toContain("--bin paperclip-runnerd");
    expect(dockerfile).toContain("build-provider-pack.mjs /provider-pack");
    expect(dockerfile).toContain(
      "/opt/paperclip-runner/provider-pack/provider-pack.json",
    );
    expect(dockerfile).toContain(
      "${PAPERCLIP_RUNNER_PROVIDER_PACK_ROOT}/node_modules/.bin",
    );
    for (const command of ["acpx", "claude-agent-acp", "codex-acp", "pi-acp"]) {
      expect(dockerfile).toContain(command);
    }
    for (const transport of ["dial_ws_loopback", "dial_wss", "listen_ws"]) {
      expect(dockerfile).toContain(transport);
      expect(workflow).toContain(transport);
    }
    expect(workflow).toContain('"binaryContractVersion":2');
    expect(workflow).toContain("--platform linux/amd64");
    expect(workflow).toContain("cosign sign --yes");
    expect(workflow).toContain(".runnerSourceRevision == $revision");
    expect(workflow).toContain("anonymous_config");
  });
});
