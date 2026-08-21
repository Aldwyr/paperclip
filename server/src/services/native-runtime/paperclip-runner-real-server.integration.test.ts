import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createRunnerdCodexTransport,
  defaultCapabilityRunnerdBinary,
} from "../../vendor/paperclip-runner/index.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import {
  registerRunnerPrpAuthority,
  runnerPrpWebSocketInternals,
  setupRunnerPrpWebSocketServer,
} from "../../realtime/runner-prp-ws.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

describe("paperclip-runner real server vertical slice", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const companyId = "00000000-0000-4000-8000-000000000701";
  const agentId = "00000000-0000-4000-8000-000000000702";
  const issueId = "00000000-0000-4000-8000-000000000703";
  const runId = "00000000-0000-4000-8000-000000000704";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-runner-real-server-");
  });

  afterAll(async () => {
    runnerPrpWebSocketInternals.resetForTests();
    await temporary.cleanup();
  });

  it("runs Rust runnerd through Paperclip PRP and reads the real bound task", async () => {
    const db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Real runner slice", issuePrefix: "RRS" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Real runner agent",
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" },
      runtimeConfig: {},
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "RRS-1",
      title: "Read me through the real control plane",
      status: "in_progress",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      invocationSource: "assignment",
      triggerDetail: "system",
      contextSnapshot: { issueId },
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));

    const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
    const server = createServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP listener.");
    setupRunnerPrpWebSocketServer(server, { port: address.port });
    const bundle = createRunnerdCodexTransport({
      runnerBinary: defaultCapabilityRunnerdBinary(),
      codexCommand: resolve(import.meta.dirname, "../../../../packages/paperclip-runner/runner/target/debug/fake-codex-app-server"),
      codexArgs: [],
      prpIdentity: {
        runnerInstanceId: "runner-real-server",
        environmentLeaseId: "lease-real-server",
        runId,
        normalizedSessionId: "session-real-server",
        turnId: "turn-real-server",
        itemId: "item-real-server",
      },
      controlPlaneRegistration: (prp) => registerRunnerPrpAuthority({ runId, authority: prp }),
    });
    const observedResults: unknown[] = [];
    bundle.transport.setServerRequestHandler(async (request) => {
      const params = request.params as Record<string, unknown>;
      const result = await authority.execute({
        tool: String(params.tool),
        callId: String(params.callId),
        arguments: params.arguments,
      });
      observedResults.push(result);
      return {
        success: true,
        contentItems: [{ type: "inputText", text: JSON.stringify({ ok: true, result }) }],
      };
    });

    try {
      await bundle.transport.request("initialize", {});
      await bundle.transport.request("thread/start", {
        cwd: tmpdir(),
        dynamicTools: authority.definitions(),
      });
      await bundle.transport.request("turn/start", {
        input: [{ type: "text", text: "Read your assigned task context." }],
      });
      for await (const notification of bundle.transport.notifications()) {
        if (notification.method === "turn/completed") break;
      }
      expect(observedResults).toHaveLength(1);
      expect(observedResults[0]).toMatchObject({
        activeTask: { id: issueId, identifier: "RRS-1", title: "Read me through the real control plane" },
        actor: { id: agentId },
        run: { id: runId },
      });
      expect(bundle.evidence().diagnostics).toContain("runnerd authenticated to the durable PRP control plane");
    } finally {
      await bundle.transport.close();
      server.closeAllConnections();
      server.close();
    }
  }, 30_000);
});
