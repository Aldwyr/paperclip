// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { TaskChatRunnerTurn } from "./TaskChatRunnerTurn";
import type { TaskChatItem } from "./task-chat-model";

describe("TaskChatRunnerTurn", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (items: TaskChatItem[], status = "running", runId = "run-1") => act(() => root.render(
    <ThemeProvider>
      <TaskChatRunnerTurn runId={runId} agentName="Runner" items={items} status={status} startedAtMs={Date.now() - 2_000} toolSummary={null} />
    </ThemeProvider>,
  ));

  it("shows immediate Thinking before the first runner event", () => {
    render([], "queued");
    expect(container.textContent).toContain("Thinking");
    expect(container.textContent).toContain("Runner");
    expect(container.querySelector('[data-testid="task-chat-current-activity"] svg')).toBeNull();
    expect(container.textContent).not.toContain("Working");
    expect(container.textContent).not.toContain("Waiting for transcript");
    const identity = container.querySelector('[data-testid="task-chat-agent-identity"]');
    const activity = container.querySelector('[data-testid="task-chat-current-activity"]');
    expect(identity?.compareDocumentPosition(activity!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("keeps progress separate from the replace-in-place current command", () => {
    render([
      { id: "p1", kind: "message", author: "agent", text: "Running the exact command now.", interstitial: true, channel: "progress", streaming: true },
      { id: "t1", kind: "tool", name: "command", rawName: "Bash", target: "for i in 1 2 3 4; do echo STREAM-$i; done", status: "in_progress", detail: "STREAM-1\n" },
    ]);
    expect(container.querySelector('[data-testid="task-chat-progress-update"]')?.textContent).toContain("Running the exact command now.");
    expect(container.querySelector('[data-testid="task-chat-current-activity"]')?.textContent).toContain("Running a command");
    expect(container.textContent).toContain("STREAM-$i");
    const identity = container.querySelector('[data-testid="task-chat-agent-identity"]');
    const activity = container.querySelector('[data-testid="task-chat-current-activity"]');
    expect(identity?.compareDocumentPosition(activity!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(container.querySelector('[data-testid="task-chat-runner-identity-row"]')?.classList.contains("pt-2")).toBe(true);
  });

  it("streams the final response in its durable slot and hides current activity", () => {
    render([
      { id: "p1", kind: "message", author: "agent", text: "Checking.", interstitial: true, channel: "progress" },
      { id: "f1", kind: "message", author: "agent", authorName: "Runner", text: "Completed successfully.", channel: "final", streaming: true },
    ]);
    expect(container.querySelector('[data-testid="task-chat-final-response"]')?.textContent).toContain("Completed successfully.");
    expect(container.querySelectorAll('[data-testid="task-chat-agent-avatar"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="task-chat-current-activity"]')).toBeNull();
  });

  it("keeps final text mounted through a transient replay gap", () => {
    render([
      { id: "f1", kind: "message", author: "agent", authorName: "Runner", text: "Completed successfully.", channel: "final", streaming: true },
    ]);
    render([{ id: "t1", kind: "tool", name: "Paperclip_finish", status: "completed" }]);

    expect(container.querySelector('[data-testid="task-chat-final-response"]')?.textContent)
      .toContain("Completed successfully.");
    expect(container.querySelectorAll('[data-testid="task-chat-final-response"]')).toHaveLength(1);
  });

  it("clears replay-latched final text when the next run takes over the lane", () => {
    render([
      { id: "f1", kind: "message", author: "agent", authorName: "Runner", text: "First answer.", channel: "final" },
    ], "running", "run-1");
    render([], "running", "run-2");

    expect(container.textContent).not.toContain("First answer.");
    expect(container.querySelector('[data-testid="task-chat-current-activity"]')?.textContent)
      .toContain("Thinking");
  });

  it("omits runner lifecycle and token noise while preserving useful history", () => {
    render([
      { id: "session", kind: "marker", variant: "session_start", label: "Session started", detail: "session-id" },
      { id: "start", kind: "marker", variant: "turn_boundary", label: "Turn started" },
      { id: "usage", kind: "usage", usage: { used: 10_520, size: 0, inputTokens: 10_254, outputTokens: 266 } },
      { id: "tool", kind: "tool", name: "Paperclip_finish", rawName: "paperclip_finish", target: "reportedWorkDisposition: done", status: "completed" },
      { id: "interrupt", kind: "marker", variant: "interrupted", label: "Interrupted" },
      { id: "complete", kind: "marker", variant: "turn_boundary", label: "Turn completed" },
    ]);

    expect(container.textContent).toContain("Paperclip_finish");
    expect(container.textContent).toContain("Interrupted");
    expect(container.textContent).not.toContain("Session started");
    expect(container.textContent).not.toContain("Turn started");
    expect(container.textContent).not.toContain("Turn completed");
    expect(container.textContent).not.toContain("10,520");
  });
});
