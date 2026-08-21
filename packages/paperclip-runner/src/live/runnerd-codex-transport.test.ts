import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { expect, it } from "vitest";

import { createCapabilityRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";

const fakeCodex = resolve(
  import.meta.dirname,
  "../../runner/target/debug/fake-codex-app-server",
);

it("runs the lab provider boundary through authenticated durable PRP", async () => {
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: [],
  });
  bundle.transport.setServerRequestHandler(async (request) => ({
    success: true,
    contentItems: [{
      type: "inputText",
      text: JSON.stringify({ ok: true, result: { task: { title: "PRP lab task" } } }),
    }],
  }));
  try {
    await bundle.transport.request("initialize", {});
    const opened = await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [{
        name: "get_task_context",
        description: "Read the active task.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }],
    });
    expect(opened.thread).toMatchObject({ modelProvider: "openai" });
    await bundle.transport.request("turn/start", {
      input: [{ type: "text", text: "Read the task." }],
    });
    const methods: string[] = [];
    for await (const notification of bundle.transport.notifications()) {
      methods.push(notification.method);
      if (notification.method === "turn/completed") break;
    }
    expect(methods).toContain("turn/completed");
    expect(bundle.evidence().diagnostics).toContain(
      "runnerd authenticated to the durable PRP control plane",
    );
  } finally {
    await bundle.transport.close();
  }
  expect(bundle.evidence()).toMatchObject({ runnerExited: true, runnerExitCode: 0 });
}, 30_000);
