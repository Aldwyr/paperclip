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

  const render = (items: TaskChatItem[], status = "running") => act(() => root.render(
    <ThemeProvider>
      <TaskChatRunnerTurn items={items} status={status} startedAtMs={Date.now() - 2_000} toolSummary={null} />
    </ThemeProvider>,
  ));

  it("shows immediate Thinking before the first runner event", () => {
    render([], "queued");
    expect(container.textContent).toContain("Thinking");
    expect(container.textContent).not.toContain("Working");
    expect(container.textContent).not.toContain("Waiting for transcript");
  });

  it("keeps progress separate from the replace-in-place current command", () => {
    render([
      { id: "p1", kind: "message", author: "agent", text: "Running the exact command now.", interstitial: true, channel: "progress", streaming: true },
      { id: "t1", kind: "tool", name: "command", rawName: "Bash", target: "for i in 1 2 3 4; do echo STREAM-$i; done", status: "in_progress", detail: "STREAM-1\n" },
    ]);
    expect(container.querySelector('[data-testid="task-chat-progress-update"]')?.textContent).toContain("Running the exact command now.");
    expect(container.querySelector('[data-testid="task-chat-current-activity"]')?.textContent).toContain("Running a command");
    expect(container.textContent).toContain("STREAM-$i");
  });

  it("streams the final response in its durable slot and hides current activity", () => {
    render([
      { id: "p1", kind: "message", author: "agent", text: "Checking.", interstitial: true, channel: "progress" },
      { id: "f1", kind: "message", author: "agent", text: "Completed successfully.", channel: "final", streaming: true },
    ]);
    expect(container.querySelector('[data-testid="task-chat-final-response"]')?.textContent).toContain("Completed successfully.");
    expect(container.querySelector('[data-testid="task-chat-current-activity"]')).toBeNull();
  });
});
