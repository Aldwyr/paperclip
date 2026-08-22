// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { TaskChatProtocolCard } from "./TaskChatProtocolCard";
import type { TaskChatProtocolItem, TaskChatRuntimeRequestDecision } from "./task-chat-model";

function renderCard(root: Root, item: TaskChatProtocolItem, onDecision?: (decision: TaskChatRuntimeRequestDecision) => void | Promise<void>) {
  flushSync(() => root.render(
    <MemoryRouter>
      <ThemeProvider>
        <TaskChatProtocolCard item={item} onRuntimeRequestDecision={onDecision ? (_request, decision) => onDecision(decision) : undefined} />
      </ThemeProvider>
    </MemoryRouter>,
  ));
}

describe("TaskChatProtocolCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it("renders provider plan steps and status", () => {
    renderCard(root, {
      id: "provider-plan",
      kind: "protocol",
      surface: "provider_activity",
      family: "plan",
      eventType: "plan.updated",
      status: "running",
      title: "Plan",
      summary: "Implement protocol surfaces",
      details: [],
      links: [],
      children: [],
      steps: [{ id: "one", label: "Inventory events", status: "completed" }, { id: "two", label: "Render widgets", status: "in_progress" }],
    });
    expect(container.querySelector('[data-testid="task-chat-provider-plan"]')).not.toBeNull();
    expect(container.textContent).toContain("Inventory events");
    expect(container.textContent).toContain("Render widgets");
  });

  it("opens a workspace diff review dialog", async () => {
    renderCard(root, {
      id: "workspace",
      kind: "protocol",
      surface: "workspace_change",
      changeSetId: "changes-1",
      revision: 1,
      source: "runner_verified",
      complete: true,
      files: [{ path: "ui/src/App.tsx", operation: "modify", previousPath: null, additions: 1, deletions: 1, binary: false, diff: "-old\n+new" }],
      totals: { files: 1, additions: 1, deletions: 1 },
      patchArtifactRef: null,
    });
    const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent === "Review diff");
    expect(button).not.toBeUndefined();
    await act(async () => button?.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("ui/src/App.tsx");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("old");
  });

  it("opens a bounded file preview", async () => {
    renderCard(root, {
      id: "file",
      kind: "protocol",
      surface: "workspace_file",
      referenceId: "file-1",
      source: "runner_verified",
      path: "doc/protocol.md",
      displayName: "protocol.md",
      mediaType: "text/markdown",
      presentation: "document",
      line: 12,
      preview: "# Protocol preview",
      previewTruncated: false,
    });
    const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent === "Preview");
    await act(async () => button?.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Protocol preview");
  });

  it("submits a runtime choice only when a resolver is supplied", async () => {
    const onDecision = vi.fn();
    renderCard(root, {
      id: "request",
      kind: "protocol",
      surface: "runtime_request",
      runId: "run-1",
      requestId: "request-1",
      requestKind: "command_approval",
      turnId: "turn-1",
      requestType: "permission",
      status: "pending",
      prompt: "Allow command?",
      choices: [{ key: "accept", label: "Allow once" }],
      fields: [],
    }, onDecision);
    const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent === "Allow once");
    expect(button?.disabled).toBe(false);
    await act(async () => button?.click());
    expect(onDecision).toHaveBeenCalledWith({ action: "accept" });
  });
});
