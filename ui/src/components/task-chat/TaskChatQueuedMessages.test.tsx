// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueQueuedCommentQueue } from "@paperclipai/shared";
import { TaskChatQueuedMessages } from "./TaskChatQueuedMessages";

const queue: IssueQueuedCommentQueue = {
  issueId: "issue-1",
  targetRunId: "run-1",
  revision: "rev-1",
  protocol: "paperclip_runner_v1",
  steeringDisposition: "available",
  entries: ["First queued message", "Second queued message"].map((body, position) => ({
    comment: {
      id: `comment-${position + 1}`,
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "user",
      authorAgentId: null,
      authorUserId: "user-1",
      body,
      presentation: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    position,
    canEdit: true,
    canDiscard: true,
  })),
};

describe("TaskChatQueuedMessages", () => {
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

  function render(overrides: Partial<ComponentProps<typeof TaskChatQueuedMessages>> = {}) {
    const props = {
      queue,
      onEdit: vi.fn(),
      onReorder: vi.fn().mockResolvedValue(undefined),
      onSteer: vi.fn().mockResolvedValue(undefined),
      onDiscard: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    flushSync(() => root.render(<TaskChatQueuedMessages {...props} />));
    return props;
  }

  it("renders each queued message once as a compact one-line row", () => {
    render();
    const pane = container.querySelector('[data-testid="task-chat-queued-messages"]');
    expect(pane?.classList).toContain("mx-3");
    expect(pane?.classList).toContain("rounded-b-none");
    expect(pane?.classList).toContain("border-b-0");
    expect(pane?.classList).toContain("-mb-px");
    expect(container.querySelectorAll('[data-testid^="task-chat-queued-message-"]')).toHaveLength(2);
    expect(container.textContent).toContain("First queued message");
    expect(container.textContent).toContain("Second queued message");
  });

  it("removes only the acknowledged steering row", async () => {
    const props = render();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-steer-comment-1"]')?.click();
    });
    expect(props.onSteer).toHaveBeenCalledWith("comment-1", "rev-1");
    expect(container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-queued-message-comment-2"]')).not.toBeNull();
  });

  it("keeps a row queued when steering fails and announces the retryable state", async () => {
    render({ onSteer: vi.fn().mockRejectedValue(new Error("steering_timeout")) });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-steer-comment-1"]')?.click();
    });
    expect(container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')).not.toBeNull();
    expect(container.textContent).toContain("Couldn’t steer. Message is still queued.");
  });

  it("disables steering when the provider does not advertise it", () => {
    render({ queue: { ...queue, steeringDisposition: "unsupported" } });
    expect(container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-steer-comment-1"]')?.disabled)
      .toBe(true);
  });

});
