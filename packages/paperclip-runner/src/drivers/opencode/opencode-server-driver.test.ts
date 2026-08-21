import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OpenCodeServerDriver, openCodeServerDriverInternals } from "./opencode-server-driver.js";

const roots: string[] = [];
const fixture = resolve("test/fixtures/fake-opencode-server.mjs");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OpenCodeServerDriver", () => {
  it("starts an authenticated isolated server, creates a session, streams usage, aborts, and cleans up", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    const workspace = await mkdtemp(join(tmpdir(), "paperclip-opencode-workspace-"));
    roots.push(root, workspace);
    const spawns: Array<{ pid: number; processGroupId: number | null }> = [];
    const diagnostics: string[] = [];
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "test-openrouter-key",
        PAPERCLIP_API_KEY: "must-not-leak",
        UNRELATED_SECRET: "must-not-leak",
      },
      onSpawn: async (meta) => { spawns.push(meta); },
      onDiagnostic: (message) => diagnostics.push(message),
    });
    const session = await driver.openSession({ runId: "run-1", normalizedSessionId: "normalized/1", workingDirectory: workspace });
    expect(session.ids()).toMatchObject({ providerSessionId: "ses_fake_1" });
    expect(spawns).toHaveLength(1);
    const turn = await session.startTurn({ message: { role: "user", text: "finish" } });
    const events = [];
    for await (const event of session.events()) events.push(event);
    expect(events.map((event) => event.eventType)).toContain("turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ eventType: "run.result.proposed" }));
    expect(events.filter((event) => event.eventType === "item.delta")).toHaveLength(1);
    expect(events.find((event) => event.eventType === "item.delta")?.payload.text).toBe("done [guide](guide.md)");
    expect(events.find((event) => event.eventType === "workspace.change.updated")?.payload)
      .toMatchObject({ schema: "paperclip.workspace.diff.v1", source: "harness_reported", totals: { files: 1 } });
    expect(events.find((event) => event.eventType === "workspace.diff.recorded")?.payload)
      .toMatchObject({ schema: "paperclip.workspace.diff.v1", complete: true });
    expect(events.find((event) => event.eventType === "workspace.file.referenced")?.payload)
      .toMatchObject({ schema: "paperclip.workspace.file_reference.v1", path: "guide.md" });
    expect(JSON.stringify(events)).not.toContain("submitted prompt must not become assistant text");
    expect(await session.usage()).toMatchObject({
      input: 3,
      output: 2,
      costUsd: 0.001,
      provider: "openrouter",
      driverVersion: "1.18.17",
    });
    await session.interrupt?.({ turnId: turn.turnId });
    const snapshot = await session.snapshot();
    expect(snapshot.driverKind).toBe("opencode_server");
    await session.close({ reason: "test" });
    const recovered = await driver.recoverSession?.(snapshot);
    expect(recovered).toMatchObject({ recovered: true });
    await expect(recovered?.session?.read?.()).resolves.toMatchObject({ sessionId: "ses_fake_1", messages: [] });
    await recovered?.session?.close({ reason: "recovery-test" });

    const sessionRoot = join(root, "normalized_1");
    expect((await stat(sessionRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(join(sessionRoot, "config", "opencode", "opencode.json"))).mode & 0o777).toBe(0o600);
    const environment = JSON.parse(await readFile(join(sessionRoot, "data", "fake-environment.json"), "utf8"));
    const mcpEvidence = JSON.parse(await readFile(join(sessionRoot, "data", "fake-mcp-evidence.json"), "utf8"));
    expect(environment.keys).toContain("OPENROUTER_API_KEY");
    expect(environment.keys).not.toContain("PAPERCLIP_API_KEY");
    expect(environment.keys).not.toContain("UNRELATED_SECRET");
    expect(environment.projectConfigDisabled).toBe("true");
    expect(mcpEvidence.tools).toEqual(expect.arrayContaining(["paperclip_finish", "paperclip_block"]));
    const config = await readFile(join(sessionRoot, "config", "opencode", "opencode.json"), "utf8");
    expect(config).toContain("openrouter/deepseek/deepseek-v4-flash-0731");
    expect(config).toContain('"external_directory": "deny"');
    expect(config).not.toContain("test-openrouter-key");
    expect(diagnostics.join("\n")).not.toContain("test-openrouter-key");
    expect(diagnostics.join("\n")).toContain("[REDACTED]");
  });

  it("keeps OpenCode in an outer supervisor process group when requested", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    const workspace = await mkdtemp(join(tmpdir(), "paperclip-opencode-workspace-"));
    roots.push(root, workspace);
    let processGroupId: number | null | undefined;
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
      isolateProcessGroup: false,
      onSpawn: async (meta) => { processGroupId = meta.processGroupId; },
    });
    const session = await driver.openSession({ runId: "run-supervised", normalizedSessionId: "supervised", workingDirectory: workspace });
    expect(processGroupId).toBeNull();
    await session.close({ reason: "test" });
  });

  it("validates provider/model form", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    roots.push(root);
    const driver = new OpenCodeServerDriver({ model: "bad", runtimeDirectory: root });
    await expect(driver.validateConfig?.({ model: "bad" })).resolves.toMatchObject({ ok: false });
    await expect(driver.validateConfig?.({ model: "openrouter/model" })).resolves.toMatchObject({ ok: true });
  });

  it("normalizes a structured block result", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    const workspace = await mkdtemp(join(tmpdir(), "paperclip-opencode-workspace-"));
    roots.push(root, workspace);
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
    });
    const session = await driver.openSession({ runId: "run-block", normalizedSessionId: "block", workingDirectory: workspace });
    await session.startTurn({ message: { role: "user", text: "block-result" } });
    const events = [];
    for await (const event of session.events()) events.push(event);
    expect(events.find((event) => event.eventType === "run.result.proposed")?.payload)
      .toMatchObject({ reportedWorkDisposition: "blocked", blocker: { reasonCode: "test_dependency" } });
    await session.close({ reason: "test" });
  });

  it("rejects malformed and oversized SSE frames", async () => {
    const stream = (value: string) => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(value));
        controller.close();
      },
    });
    const consume = async (value: string) => {
      for await (const _event of openCodeServerDriverInternals.parseSse(stream(value))) {
        // Consume the complete stream so parse failures are observed.
      }
    };
    await expect(consume("data: {bad json}\n\n")).rejects.toThrow();
    await expect(consume(`data: ${"x".repeat(1_048_577)}`)).rejects.toThrow("payload limit");
  });

  it("restarts OpenCode when session startup fails transiently", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    const workspace = await mkdtemp(join(tmpdir(), "paperclip-opencode-workspace-"));
    roots.push(root, workspace);
    let failSessionCreate = true;
    const spawns: number[] = [];
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
      fetch: async (input, init) => {
        if (failSessionCreate && String(input).endsWith("/session") && init?.method === "POST") {
          failSessionCreate = false;
          throw new Error("transient session initialization failure");
        }
        return fetch(input, init);
      },
      onSpawn: async ({ pid }) => { spawns.push(pid); },
    });
    const session = await driver.openSession({ runId: "run-retry", normalizedSessionId: "retry", workingDirectory: workspace });
    expect(session.ids().providerSessionId).toBe("ses_fake_1");
    expect(spawns).toHaveLength(2);
    await session.close({ reason: "test" });
  });
});
