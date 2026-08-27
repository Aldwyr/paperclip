// @vitest-environment jsdom

import type { ReactElement } from "react";
import { act, forwardRef, useImperativeHandle, type ForwardedRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { TaskChatThread } from "./TaskChatThread";
import type {
  IssueDocument,
  IssueQueuedCommentQueue,
  IssueThreadInteraction,
} from "@paperclipai/shared";
import { heartbeatsApi } from "@/api/heartbeats";

const transcriptState = vi.hoisted(() => ({ transcriptByRun: new Map() }));
const sidebarState = vi.hoisted(() => ({ isMobile: false }));
const planState = vi.hoisted(() => ({ data: null as IssueDocument | null }));

vi.mock("@/components/transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => transcriptState,
}));
vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: sidebarState.isMobile }),
}));
vi.mock("@/hooks/useIssuePlanDocument", () => ({
  useIssuePlanDocument: () => planState,
}));
vi.mock("@/lib/router", () => ({
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string;
    children: React.ReactNode;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: forwardRef(function MockMarkdownEditor(
    { value }: { value: string },
    ref: ForwardedRef<unknown>,
  ) {
    useImperativeHandle(ref, () => ({
      insertMarkdown: () => {},
      focus: () => {},
    }));
    return <div data-testid="mock-editor">{value}</div>;
  }),
}));

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  localStorage.clear();
  transcriptState.transcriptByRun.clear();
  sidebarState.isMobile = false;
  planState.data = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root?.unmount());
  root = null;
  container.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

function render(ui: ReactElement) {
  flushSync(() => root!.render(<ThemeProvider>{ui}</ThemeProvider>));
}

function fakeScrollGeometry(
  element: HTMLElement,
  { scrollHeight = 1000, clientHeight = 400, scrollTop = 600 } = {},
) {
  let currentScrollTop = scrollTop;
  Object.defineProperty(element, "scrollHeight", {
    value: scrollHeight,
    configurable: true,
  });
  Object.defineProperty(element, "clientHeight", {
    value: clientHeight,
    configurable: true,
  });
  Object.defineProperty(element, "scrollTop", {
    get: () => currentScrollTop,
    set: (value: number) => {
      currentScrollTop = value;
    },
    configurable: true,
  });
}

function planDocument(overrides: Partial<IssueDocument> = {}): IssueDocument {
  return {
    id: "document-plan",
    companyId: "company-1",
    issueId: "issue-1",
    key: "plan",
    title: "Plan",
    format: "markdown",
    body: "# Preview the Plan\n- Reuse the review card.\n- Stream live steps.\n- Reconcile the revision.",
    latestRevisionId: "revision-3",
    latestRevisionNumber: 3,
    createdByAgentId: "agent-1",
    createdByUserId: null,
    updatedByAgentId: "agent-1",
    updatedByUserId: null,
    lockedAt: null,
    lockedByAgentId: null,
    lockedByUserId: null,
    createdAt: new Date("2026-08-23T10:00:00.000Z"),
    updatedAt: new Date("2026-08-23T10:01:00.000Z"),
    ...overrides,
  };
}

function planReviewInteraction(
  status: "pending" | "accepted" | "expired" = "pending",
  revisionId = "revision-3",
  sourceRunId: string | null = "run-plan",
): IssueThreadInteraction {
  const isResolved = status !== "pending";
  return {
    id: "plan-review",
    companyId: "company-1",
    issueId: "issue-1",
    kind: "request_confirmation",
    title: "Review the Plan",
    summary: null,
    status,
    continuationPolicy: "wake_assignee",
    resolverPolicy: "anyone",
    requestedResolverPolicy: "anyone",
    effectiveResolverPolicy: "anyone",
    resolverPolicyProvenance: "inherited",
    effectiveResolverPolicySource: "requested",
    legacyResolverPolicyAliases: {
      requested: "board_or_agents",
      effective: "board_or_agents",
    },
    createdByAgentId: "agent-1",
    createdByUserId: null,
    sourceRunId,
    resolvedByAgentId: null,
    resolvedByUserId: isResolved ? "user-1" : null,
    createdAt: new Date("2026-08-23T10:01:01.000Z"),
    updatedAt: new Date("2026-08-23T10:01:01.000Z"),
    resolvedAt: isResolved ? new Date("2026-08-23T10:02:00.000Z") : null,
    payload: {
      version: 1,
      prompt: "Approve this Plan?",
      target: {
        type: "issue_document",
        issueId: "issue-1",
        documentId: "document-plan",
        key: "plan",
        revisionId,
        revisionNumber: 3,
        label: "Plan revision 3",
      },
    },
    result:
      status === "accepted"
        ? { outcome: "accepted" }
        : status === "expired"
          ? {
              outcome: "superseded_by_comment",
              commentId: "follow-up-comment",
            }
          : null,
  } as IssueThreadInteraction;
}

function questionInteraction(
  id: string,
  prompt: string,
  createdAt: string,
): IssueThreadInteraction {
  return {
    id,
    companyId: "company-1",
    issueId: "issue-1",
    kind: "ask_user_questions",
    title: prompt,
    status: "pending",
    continuationPolicy: "wake_assignee",
    resolverPolicy: "anyone",
    requestedResolverPolicy: "anyone",
    effectiveResolverPolicy: "anyone",
    resolverPolicyProvenance: "inherited",
    effectiveResolverPolicySource: "requested",
    legacyResolverPolicyAliases: {
      requested: "board_or_agents",
      effective: "board_or_agents",
    },
    createdByAgentId: "agent-1",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    resolvedAt: null,
    payload: {
      version: 1,
      questions: [
        {
          id: `${id}-question`,
          prompt,
          selectionMode: "single",
          required: true,
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
        },
      ],
    },
    result: null,
  } as IssueThreadInteraction;
}

describe("TaskChatThread draft pass-through", () => {
  it("aligns the desktop thread header with the side-panel tab row", () => {
    render(
      <TaskChatThread
        comments={[
          {
            id: "comment-1",
            companyId: "company-1",
            issueId: "issue-1",
            authorType: "user",
            authorAgentId: null,
            authorUserId: "user-1",
            body: "Header alignment fixture.",
            presentation: null,
            metadata: null,
            createdAt: new Date("2026-08-15T12:00:00.000Z"),
            updatedAt: new Date("2026-08-15T12:00:00.000Z"),
          },
        ]}
        onAdd={async () => {}}
      />,
    );

    const scroller = container.querySelector(
      '[data-testid="task-chat-scroller"]',
    );
    expect(scroller?.firstElementChild?.classList).toContain("pt-3");
  });

  it("keeps the composer dock aligned with the thread's horizontal padding", () => {
    render(
      <TaskChatThread
        comments={[
          {
            id: "comment-1",
            companyId: "company-1",
            issueId: "issue-1",
            authorType: "user",
            authorAgentId: null,
            authorUserId: "user-1",
            body: "Waiting for the dependency.",
            presentation: null,
            metadata: null,
            createdAt: new Date("2026-08-15T12:00:00.000Z"),
            updatedAt: new Date("2026-08-15T12:00:00.000Z"),
          },
        ]}
        onAdd={async () => {}}
      />,
    );

    const dock = container.querySelector(
      '[data-testid="task-chat-composer-dock"]',
    );
    expect(dock?.classList).toContain("px-4");
    expect(dock?.classList).not.toContain("px-1");
  });

  it("forwards draftKey so the composer restores a task's saved draft", () => {
    localStorage.setItem("task-chat-draft:issue-1", "half-written thought");

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        draftKey="task-chat-draft:issue-1"
      />,
    );

    expect(
      container.querySelector('[data-testid="mock-editor"]')?.textContent,
    ).toBe("half-written thought");
  });

  it("forwards human profiles to the selected composer assignee", () => {
    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        enableReassign
        reassignOptions={[{ id: "user:user-1", label: "Riley Board" }]}
        currentAssigneeValue="user:user-1"
        userProfileMap={
          new Map([
            ["user-1", { label: "Riley Board", image: "/riley-avatar.png" }],
          ])
        }
      />,
    );

    expect(
      container.querySelector('[data-assignee-trigger-avatar="user-1"]'),
    ).not.toBeNull();
  });
});

describe("TaskChatThread composer takeovers", () => {
  const latestComment = {
    id: "comment-latest",
    companyId: "company-1",
    issueId: "issue-1",
    authorType: "user" as const,
    authorAgentId: null,
    authorUserId: "user-1",
    body: "Can we add boats and monsters?",
    presentation: null,
    metadata: null,
    createdAt: new Date("2026-08-25T14:15:02.000Z"),
    updatedAt: new Date("2026-08-25T14:15:02.000Z"),
  };

  it("keeps the latest turn visible when a question takeover grows the composer", () => {
    const interaction = questionInteraction(
      "question-boats",
      "How deep should boats go?",
      "2026-08-25T14:17:26.000Z",
    );
    const baseProps = {
      comments: [latestComment],
      issueId: "issue-1",
      onAdd: async () => {},
      onSubmitInteractionAnswers: async () => {},
    };

    render(<TaskChatThread {...baseProps} />);
    const scroller = container.querySelector<HTMLElement>(
      '[data-testid="task-chat-scroller"]',
    )!;
    fakeScrollGeometry(scroller);

    render(<TaskChatThread {...baseProps} interactions={[interaction]} />);

    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    expect(
      container.querySelector('[data-testid="task-chat-composer-takeover"]'),
    ).not.toBeNull();
  });

  it("does not follow a question takeover when the reader is scrolled up", async () => {
    const interaction = questionInteraction(
      "question-boats",
      "How deep should boats go?",
      "2026-08-25T14:17:26.000Z",
    );
    const baseProps = {
      comments: [latestComment],
      issueId: "issue-1",
      onAdd: async () => {},
      onSubmitInteractionAnswers: async () => {},
    };

    render(<TaskChatThread {...baseProps} />);
    const scroller = container.querySelector<HTMLElement>(
      '[data-testid="task-chat-scroller"]',
    )!;
    fakeScrollGeometry(scroller, { scrollTop: 100 });
    await act(async () => {
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await Promise.resolve();
    });

    render(<TaskChatThread {...baseProps} interactions={[interaction]} />);

    expect(scroller.scrollTop).toBe(100);
    expect(
      container.querySelector('[aria-label="Scroll to latest"]'),
    ).not.toBeNull();
  });

  it("moves a pending question's action into the composer without a timeline marker", async () => {
    const interaction = questionInteraction(
      "question-1",
      "Which environment?",
      "2026-08-24T10:00:00.000Z",
    );
    const onSkipInteraction = vi.fn().mockResolvedValue(undefined);
    render(
      <TaskChatThread
        comments={[]}
        interactions={[interaction]}
        issueId="issue-1"
        onAdd={async () => {}}
        onSkipInteraction={onSkipInteraction}
        onSubmitInteractionAnswers={async () => {}}
      />,
    );

    expect(
      container.querySelector('[data-testid="task-chat-composer-takeover"]')
        ?.textContent,
    ).toContain("Which environment?");
    expect(container.textContent).not.toContain("Asked questions");
    expect(container.querySelector('[data-testid="mock-editor"]')).toBeNull();

    const dismiss = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-composer-takeover"] button[aria-label^="Dismiss "]',
    );
    flushSync(() => dismiss?.click());
    expect(onSkipInteraction).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="mock-editor"]'),
    ).not.toBeNull();

    const reopen = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-pending-input-indicator"]',
    );
    flushSync(() => reopen?.click());
    expect(container.querySelector('[data-testid="mock-editor"]')).toBeNull();

    const skip = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "Skip");
    await act(async () => {
      skip?.click();
      await Promise.resolve();
    });

    expect(onSkipInteraction).toHaveBeenCalledWith(interaction);
    expect(
      container.querySelector('[data-testid="mock-editor"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="task-chat-pending-input-indicator"]',
      ),
    ).not.toBeNull();
  });

  it("shows the newest durable request first and cycles the compact pending switcher", () => {
    const older = questionInteraction(
      "question-old",
      "Older question",
      "2026-08-24T10:00:00.000Z",
    );
    const newer = questionInteraction(
      "question-new",
      "Newer question",
      "2026-08-24T10:01:00.000Z",
    );
    render(
      <TaskChatThread
        comments={[]}
        interactions={[older, newer]}
        issueId="issue-1"
        onAdd={async () => {}}
        onSkipInteraction={async () => {}}
        onSubmitInteractionAnswers={async () => {}}
      />,
    );

    expect(
      container.querySelector('[data-testid="task-chat-composer-takeover"]')
        ?.textContent,
    ).toContain("Newer question");
    const switcher = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "2 pending");
    flushSync(() => switcher?.click());
    expect(
      container.querySelector('[data-testid="task-chat-composer-takeover"]')
        ?.textContent,
    ).toContain("Older question");
  });
});

describe("TaskChatThread causal comment ordering", () => {
  it("places a queued input where its consuming run starts", () => {
    const comment = (
      id: string,
      body: string,
      createdAt: string,
      authorType: "user" | "agent",
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      companyId: "company-1",
      issueId: "issue-1",
      authorType,
      authorAgentId: authorType === "agent" ? "agent-1" : null,
      authorUserId: authorType === "user" ? "user-1" : null,
      body,
      presentation: null,
      metadata: null,
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
      ...extra,
    });
    render(
      <TaskChatThread
        comments={[
          comment(
            "initial",
            "Initial recipe request",
            "2026-08-22T12:00:00.000Z",
            "user",
          ),
          comment(
            "queued",
            "What about BBQ sauce?",
            "2026-08-22T12:01:00.000Z",
            "user",
            {
              consumedByRunId: "run-2",
              conversationAnchorAt: "2026-08-22T12:03:00.000Z",
              conversationAnchorSequence: 0,
            },
          ),
          comment(
            "reply-1",
            "Pork shoulder recipe",
            "2026-08-22T12:02:00.000Z",
            "agent",
            { runId: "run-1" },
          ),
          comment(
            "reply-2",
            "BBQ sauce recipe",
            "2026-08-22T12:04:00.000Z",
            "agent",
            { runId: "run-2" },
          ),
        ]}
        onAdd={async () => {}}
      />,
    );

    const text = container.textContent ?? "";
    expect(text.indexOf("Initial recipe request")).toBeLessThan(
      text.indexOf("Pork shoulder recipe"),
    );
    expect(text.indexOf("Pork shoulder recipe")).toBeLessThan(
      text.indexOf("What about BBQ sauce?"),
    );
    expect(text.indexOf("What about BBQ sauce?")).toBeLessThan(
      text.indexOf("BBQ sauce recipe"),
    );
  });

  it("places same-turn steering between collapsed work and the final reply", () => {
    transcriptState.transcriptByRun.set("run-steered", [
      {
        kind: "assistant",
        ts: "2026-08-22T12:01:30.000Z",
        channel: "commentary",
        text: "Implementing the original request.",
      },
      {
        kind: "assistant",
        ts: "2026-08-22T12:02:30.000Z",
        channel: "commentary",
        text: "Incorporating the steering request.",
      },
    ]);
    const comment = (
      id: string,
      body: string,
      createdAt: string,
      authorType: "user" | "agent",
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      companyId: "company-1",
      issueId: "issue-1",
      authorType,
      authorAgentId: authorType === "agent" ? "agent-1" : null,
      authorUserId: authorType === "user" ? "user-1" : null,
      body,
      presentation: null,
      metadata: null,
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
      ...extra,
    });

    render(
      <TaskChatThread
        comments={[
          comment(
            "initial",
            "Initial implementation request",
            "2026-08-22T12:00:00.000Z",
            "user",
          ),
          comment(
            "steer",
            "Also add kebab case",
            "2026-08-22T12:00:30.000Z",
            "user",
            {
              consumedByRunId: "run-steered",
              steeredIntoRunId: "run-steered",
              conversationAnchorAt: "2026-08-22T12:02:00.000Z",
              conversationAnchorSequence: 0,
            },
          ),
          comment(
            "reply",
            "Implemented both requests",
            "2026-08-22T12:03:00.000Z",
            "agent",
            {
              runId: "run-steered",
            },
          ),
        ]}
        linkedRuns={[
          {
            runId: "run-steered",
            status: "succeeded",
            agentId: "agent-1",
            agentName: "Runner",
            adapterType: "paperclip_runner",
            createdAt: "2026-08-22T12:01:00.000Z",
            startedAt: "2026-08-22T12:01:00.000Z",
            finishedAt: "2026-08-22T12:03:00.000Z",
            resultJson: null,
          },
        ]}
        onAdd={async () => {}}
      />,
    );

    const text = container.textContent ?? "";
    expect(text.indexOf("Initial implementation request")).toBeLessThan(
      text.indexOf("Worked"),
    );
    expect(text.indexOf("Worked")).toBeLessThan(
      text.indexOf("Also add kebab case"),
    );
    expect(text.indexOf("Also add kebab case")).toBeLessThan(
      text.lastIndexOf("Worked"),
    );
    expect(text.lastIndexOf("Worked")).toBeLessThan(
      text.indexOf("Implemented both requests"),
    );
  });

  it("keeps a live steering bubble between pre-steer work and the continuing tail", () => {
    transcriptState.transcriptByRun.set("run-live-steered", [
      {
        kind: "assistant",
        ts: "2026-08-25T17:20:50.000Z",
        channel: "progress",
        text: "I’m inspecting the original task first.",
      },
      {
        kind: "tool_call",
        ts: "2026-08-25T17:21:00.000Z",
        name: "Read",
        toolUseId: "read-before-steer",
        input: { path: "SKILL.md" },
      },
      {
        kind: "tool_result",
        ts: "2026-08-25T17:21:01.000Z",
        toolUseId: "read-before-steer",
        toolName: "Read",
        content: "Original skill inventory",
        isError: false,
      },
      {
        kind: "assistant",
        ts: "2026-08-25T17:21:50.000Z",
        channel: "progress",
        text: "I’ve adopted the newly installed skill.",
      },
      {
        kind: "tool_call",
        ts: "2026-08-25T17:22:00.000Z",
        name: "Bash",
        toolUseId: "refresh-after-steer",
        input: { command: "refresh-skills" },
      },
    ]);
    const steerComment = {
      id: "steer-live",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "user" as const,
      authorAgentId: null,
      authorUserId: "user-1",
      body: "I just installed a new skill, check it out",
      presentation: null,
      metadata: null,
      createdAt: new Date("2026-08-25T17:21:43.078Z"),
      updatedAt: new Date("2026-08-25T17:21:43.078Z"),
      consumedByRunId: "run-live-steered",
      steeredIntoRunId: "run-live-steered",
      conversationAnchorAt: "2026-08-25T17:21:44.541Z",
      conversationAnchorSequence: 0,
    };
    const replyComment = {
      id: "reply-live-steered",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "agent" as const,
      authorAgentId: "agent-1",
      authorUserId: null,
      body: "Finished after applying the steering request.",
      presentation: null,
      metadata: null,
      createdAt: new Date("2026-08-25T17:22:34.375Z"),
      updatedAt: new Date("2026-08-25T17:22:34.375Z"),
      runId: "run-live-steered",
    };
    const activeRun = {
      id: "run-live-steered",
      status: "running" as const,
      invocationSource: "issue" as const,
      triggerDetail: null,
      startedAt: "2026-08-25T17:20:45.369Z",
      finishedAt: null,
      createdAt: "2026-08-25T17:20:45.369Z",
      agentId: "agent-1",
      agentName: "Runner",
      adapterType: "paperclip_runner",
    };
    const assertSteeringOrder = () => {
      const text = container.textContent ?? "";
      const before = text.indexOf("I’m inspecting the original task first.");
      const steer = text.indexOf("I just installed a new skill, check it out");
      const after = text.indexOf("I’ve adopted the newly installed skill.");
      expect(before).toBeGreaterThanOrEqual(0);
      expect(before).toBeLessThan(steer);
      expect(steer).toBeLessThan(after);
      expect(
        text.match(/I’m inspecting the original task first\./g),
      ).toHaveLength(1);
      expect(
        text.match(/I’ve adopted the newly installed skill\./g),
      ).toHaveLength(1);
    };

    render(
      <TaskChatThread
        comments={[steerComment, replyComment]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={activeRun}
      />,
    );

    assertSteeringOrder();
    expect(container.textContent).toContain("Worked for 59s");
    const liveTranscript = container.querySelector(
      '[data-testid="task-chat-live-transcript"]',
    );
    expect(liveTranscript?.textContent).not.toContain(
      "I’m inspecting the original task first.",
    );
    expect(liveTranscript?.textContent).toContain(
      "I’ve adopted the newly installed skill.",
    );

    render(
      <TaskChatThread
        comments={[steerComment, replyComment]}
        linkedRuns={[
          {
            runId: "run-live-steered",
            status: "succeeded",
            agentId: "agent-1",
            agentName: "Runner",
            adapterType: "paperclip_runner",
            createdAt: "2026-08-25T17:20:45.369Z",
            startedAt: "2026-08-25T17:20:45.369Z",
            finishedAt: "2026-08-25T17:22:34.375Z",
            resultJson: null,
          },
        ]}
        onAdd={async () => {}}
        issueStatus="in_review"
        activeRun={{
          ...activeRun,
          status: "succeeded",
          finishedAt: "2026-08-25T17:22:34.375Z",
        }}
      />,
    );

    assertSteeringOrder();
    expect(
      container.querySelector('[data-testid="task-chat-live-transcript"]'),
    ).toBeNull();
  });

  it("places a plan acceptance between the run before the decision and the run it wakes", () => {
    transcriptState.transcriptByRun.set("run-before-acceptance", [
      {
        kind: "assistant",
        ts: "2026-08-25T14:45:20.000Z",
        channel: "progress",
        text: "Verifying the answered scope choices.",
      },
    ]);
    transcriptState.transcriptByRun.set("run-after-acceptance", [
      {
        kind: "assistant",
        ts: "2026-08-25T14:48:12.000Z",
        channel: "progress",
        text: "Loading the accepted plan for implementation.",
      },
    ]);
    const answeredQuestions = {
      id: "question-response:boats",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "user" as const,
      authorAgentId: null,
      authorUserId: "user-1",
      body: "Answered questions\n\n- Boat scope: Combat + transport",
      presentation: null,
      metadata: null,
      createdAt: new Date("2026-08-25T14:45:17.027Z"),
      updatedAt: new Date("2026-08-25T14:45:17.027Z"),
      consumedByRunId: "run-before-acceptance",
      conversationAnchorAt: new Date("2026-08-25T14:45:17.027Z"),
      conversationAnchorSequence: 0,
    };
    const planningReply = {
      id: "planning-reply",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "agent" as const,
      authorAgentId: "agent-1",
      authorUserId: null,
      body: "Completed and verified the decision-complete plan.",
      presentation: null,
      metadata: null,
      createdAt: new Date("2026-08-25T14:46:00.661Z"),
      updatedAt: new Date("2026-08-25T14:46:00.661Z"),
    };
    const acceptedPlanResponse = {
      id: "interaction-response:accepted-plan-review",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "user" as const,
      authorAgentId: null,
      authorUserId: "user-1",
      body: "Approved plan",
      presentation: null,
      metadata: null,
      createdAt: new Date("2026-08-25T14:48:09.707Z"),
      updatedAt: new Date("2026-08-25T14:48:09.707Z"),
      conversationAnchorAt: new Date("2026-08-25T14:48:09.707Z"),
      conversationAnchorSequence: 0,
    };
    const acceptedReview = {
      ...planReviewInteraction("accepted"),
      id: "accepted-plan-review",
      sourceRunId: "run-review-source",
      createdAt: new Date("2026-08-25T14:44:59.728Z"),
      updatedAt: new Date("2026-08-25T14:48:09.707Z"),
      resolvedAt: new Date("2026-08-25T14:48:09.707Z"),
    };

    render(
      <TaskChatThread
        comments={[answeredQuestions, planningReply, acceptedPlanResponse]}
        interactions={[acceptedReview]}
        linkedRuns={[
          {
            runId: "run-before-acceptance",
            status: "succeeded",
            agentId: "agent-1",
            agentName: "Runner",
            adapterType: "paperclip_runner",
            createdAt: "2026-08-25T14:45:17.016Z",
            startedAt: "2026-08-25T14:45:17.027Z",
            finishedAt: "2026-08-25T14:46:00.644Z",
            resultJson: null,
          },
          {
            runId: "run-after-acceptance",
            status: "succeeded",
            agentId: "agent-1",
            agentName: "Runner",
            adapterType: "paperclip_runner",
            createdAt: "2026-08-25T14:48:09.754Z",
            startedAt: "2026-08-25T14:48:09.770Z",
            finishedAt: "2026-08-25T14:50:45.928Z",
            resultJson: null,
          },
        ]}
        onAdd={async () => {}}
        issueId="issue-1"
      />,
    );

    const text = container.textContent ?? "";
    expect(text.indexOf("Answered questions")).toBeLessThan(
      text.indexOf("Verifying the answered scope choices."),
    );
    expect(text.indexOf("Verifying the answered scope choices.")).toBeLessThan(
      text.indexOf("Completed and verified the decision-complete plan."),
    );
    expect(
      text.indexOf("Completed and verified the decision-complete plan."),
    ).toBeLessThan(text.indexOf("Approved plan"));
    expect(text.indexOf("Approved plan")).toBeLessThan(
      text.indexOf("Loading the accepted plan for implementation."),
    );
    expect(text).not.toContain("Confirmed request");
    expect(
      container.querySelectorAll('[data-testid="task-chat-turn"]'),
    ).toHaveLength(2);
  });

  it.each(["acpx_local", "claude_local", "codex_local"])(
    "segments live and settled %s legacy transcripts around requests and queued responses",
    (adapterType) => {
      const runId = `run-${adapterType}`;
      transcriptState.transcriptByRun.set(runId, [
        {
          kind: "assistant",
          ts: "2026-08-25T12:00:15.000Z",
          channel: "progress",
          text: "Legacy work before the question.",
        },
        {
          kind: "assistant",
          // Equal to the response timestamp: the durable response must win the
          // tie and stay before the continuation transcript.
          ts: "2026-08-25T12:02:00.000Z",
          channel: "progress",
          text: "Legacy work after the answer.",
        },
      ]);
      const answeredInteraction = {
        ...questionInteraction(
          `question-${adapterType}`,
          "Choose runtime",
          "2026-08-25T12:00:30.000Z",
        ),
        status: "answered",
        sourceRunId: runId,
        updatedAt: new Date("2026-08-25T12:02:00.000Z"),
        resolvedAt: new Date("2026-08-25T12:02:00.000Z"),
        resolvedByUserId: "user-1",
        result: {
          version: 1,
          answers: [
            {
              questionId: `question-${adapterType}-question`,
              optionIds: ["yes"],
            },
          ],
        },
      } as IssueThreadInteraction;
      const queuedResponse = {
        id: `interaction-response:question-${adapterType}`,
        companyId: "company-1",
        issueId: "issue-1",
        authorType: "user" as const,
        authorAgentId: null,
        authorUserId: "user-1",
        body: "Submitted runtime answer: Node.js",
        presentation: null,
        metadata: null,
        createdAt: new Date("2026-08-25T12:02:00.000Z"),
        updatedAt: new Date("2026-08-25T12:02:00.000Z"),
        conversationAnchorAt: new Date("2026-08-25T12:02:00.000Z"),
        conversationAnchorSequence: 0,
        queueState: "queued" as const,
        queueTargetRunId: runId,
        queueReason: "active_run" as const,
      };
      const activeRun = {
        id: runId,
        status: "running" as const,
        invocationSource: "issue" as const,
        triggerDetail: null,
        startedAt: "2026-08-25T12:00:00.000Z",
        finishedAt: null,
        createdAt: "2026-08-25T12:00:00.000Z",
        agentId: "agent-1",
        agentName: "Legacy runner",
        adapterType,
      };
      const onInterruptQueued = vi.fn(async () => {});
      const assertTimelineOrder = () => {
        const text = container.textContent ?? "";
        const before = text.indexOf("Legacy work before the question.");
        const request = text.indexOf("Choose runtime");
        const response = text.indexOf("Submitted runtime answer: Node.js");
        const after = text.indexOf("Legacy work after the answer.");
        expect(before).toBeGreaterThanOrEqual(0);
        expect(before).toBeLessThan(request);
        expect(request).toBeLessThan(response);
        expect(response).toBeLessThan(after);
      };

      render(
        <TaskChatThread
          comments={[queuedResponse]}
          interactions={[answeredInteraction]}
          onAdd={async () => {}}
          onInterruptQueued={onInterruptQueued}
          issueStatus="in_progress"
          activeRun={activeRun}
        />,
      );

      assertTimelineOrder();
      expect(
        container.querySelector('[data-testid="task-chat-live-transcript"]')
          ?.textContent,
      ).toContain("Legacy work after the answer.");
      expect(
        container.querySelector('[data-testid="task-chat-live-transcript"]')
          ?.textContent,
      ).not.toContain("Legacy work before the question.");
      expect(
        Array.from(container.querySelectorAll("button")).some(
          (button) => button.textContent === "Interrupt",
        ),
      ).toBe(true);

      render(
        <TaskChatThread
          comments={[
            {
              ...queuedResponse,
              queueState: undefined,
              queueTargetRunId: null,
              queueReason: undefined,
            },
          ]}
          interactions={[answeredInteraction]}
          linkedRuns={[
            {
              runId,
              status: "succeeded",
              agentId: "agent-1",
              agentName: "Legacy runner",
              adapterType,
              createdAt: "2026-08-25T12:00:00.000Z",
              startedAt: "2026-08-25T12:00:00.000Z",
              finishedAt: "2026-08-25T12:03:00.000Z",
              resultJson: null,
            },
          ]}
          onAdd={async () => {}}
          onInterruptQueued={onInterruptQueued}
          issueStatus="in_review"
          activeRun={{
            ...activeRun,
            status: "succeeded",
            finishedAt: "2026-08-25T12:03:00.000Z",
          }}
        />,
      );

      assertTimelineOrder();
      expect(
        container.querySelector('[data-testid="task-chat-live-transcript"]'),
      ).toBeNull();
      expect(
        Array.from(container.querySelectorAll("button")).some(
          (button) => button.textContent === "Interrupt",
        ),
      ).toBe(false);
      expect(
        container.textContent?.match(/Submitted runtime answer: Node\.js/g),
      ).toHaveLength(1);
    },
  );
});

describe("TaskChatThread Plan previews", () => {
  it("renders the canonical Plan document instead of a created divider", () => {
    planState.data = planDocument();
    render(
      <TaskChatThread comments={[]} onAdd={async () => {}} issueId="issue-1" />,
    );

    const preview = container.querySelector(
      '[data-testid="task-chat-plan-preview"]',
    );
    expect(preview?.getAttribute("href")).toBe("#document-plan");
    expect(preview?.textContent).toContain("Plan· rev 3");
    expect(preview?.textContent).toContain("Preview the Plan");
    expect(container.textContent).not.toContain("Plan created");
  });

  it("keeps an unowned Plan preview at the document position through resolution", () => {
    planState.data = planDocument();
    render(
      <TaskChatThread
        comments={[]}
        interactions={[planReviewInteraction("pending")]}
        onAdd={async () => {}}
        issueId="issue-1"
      />,
    );

    expect(container.querySelectorAll('a[href="#document-plan"]')).toHaveLength(
      1,
    );
    expect(
      container.querySelector('[data-testid="plan-review-preview"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="task-chat-plan-preview"]'),
    ).not.toBeNull();

    render(
      <TaskChatThread
        comments={[]}
        interactions={[planReviewInteraction("accepted")]}
        onAdd={async () => {}}
        issueId="issue-1"
      />,
    );
    expect(
      container.querySelector('[data-testid="plan-review-preview"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="task-chat-plan-preview"]'),
    ).not.toBeNull();
  });

  it("keeps the standalone preview when the pending review targets another revision", () => {
    planState.data = planDocument();
    render(
      <TaskChatThread
        comments={[]}
        interactions={[planReviewInteraction("pending", "revision-2")]}
        onAdd={async () => {}}
        issueId="issue-1"
      />,
    );

    expect(
      container.querySelector('[data-testid="plan-review-preview"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="task-chat-plan-preview"]'),
    ).not.toBeNull();
  });

  it("keeps a runner-authored plan in one stable turn position through settle", () => {
    planState.data = planDocument();
    transcriptState.transcriptByRun.set("run-plan", [
      {
        kind: "assistant",
        ts: "2026-08-23T10:00:05.000Z",
        text: "I’ll inspect the task context first.",
        channel: "progress",
      },
      {
        kind: "tool_call",
        ts: "2026-08-23T10:00:10.000Z",
        name: "get_task_context",
        toolUseId: "read-context",
        input: {},
      },
      {
        kind: "tool_result",
        ts: "2026-08-23T10:00:11.000Z",
        toolUseId: "read-context",
        toolName: "get_task_context",
        content: "Context loaded",
        isError: false,
      },
      {
        kind: "assistant",
        ts: "2026-08-23T10:00:20.000Z",
        text: "The workspace is greenfield.",
        channel: "progress",
      },
      {
        kind: "tool_call",
        ts: "2026-08-23T10:01:00.000Z",
        name: "write_document",
        toolUseId: "write-plan",
        input: { key: "plan" },
      },
      {
        kind: "tool_result",
        ts: "2026-08-23T10:01:00.500Z",
        toolUseId: "write-plan",
        toolName: "write_document",
        content: "Revision 3 saved",
        isError: false,
      },
      {
        kind: "assistant",
        ts: "2026-08-23T10:01:02.000Z",
        text: "The plan is now published.",
        channel: "progress",
      },
    ]);
    const activeRun = {
      id: "run-plan",
      status: "running" as const,
      invocationSource: "issue" as const,
      triggerDetail: null,
      startedAt: "2026-08-23T10:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-08-23T10:00:00.000Z",
      agentId: "agent-1",
      agentName: "Runner",
      adapterType: "paperclip_runner",
    };
    const assertStableOrder = () => {
      const text = container.textContent ?? "";
      expect(text.indexOf("I’ll inspect the task context first.")).toBeLessThan(
        text.indexOf("The workspace is greenfield."),
      );
      expect(text.indexOf("The workspace is greenfield.")).toBeLessThan(
        text.indexOf("Preview the Plan"),
      );
      expect(text.indexOf("Preview the Plan")).toBeLessThan(
        text.indexOf("The plan is now published."),
      );
      expect(text.match(/I’ll inspect the task context first\./g)).toHaveLength(
        1,
      );
      expect(text.match(/Preview the Plan/g)).toHaveLength(1);
    };

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueId="issue-1"
        issueStatus="in_progress"
        activeRun={activeRun}
      />,
    );

    const liveTranscript = container.querySelector(
      '[data-testid="task-chat-live-transcript"]',
    );
    expect(
      liveTranscript?.querySelector('[data-testid="task-chat-plan-preview"]'),
    ).not.toBeNull();
    assertStableOrder();

    render(
      <TaskChatThread
        comments={[]}
        interactions={[planReviewInteraction("pending")]}
        linkedRuns={[
          {
            runId: "run-plan",
            status: "succeeded",
            agentId: "agent-1",
            agentName: "Runner",
            adapterType: "paperclip_runner",
            createdAt: "2026-08-23T10:00:00.000Z",
            startedAt: "2026-08-23T10:00:00.000Z",
            finishedAt: "2026-08-23T10:01:32.000Z",
            resultJson: null,
          },
        ]}
        onAdd={async () => {}}
        issueId="issue-1"
        issueStatus="in_review"
        activeRun={{
          ...activeRun,
          status: "succeeded",
          finishedAt: "2026-08-23T10:01:32.000Z",
        }}
      />,
    );

    expect(
      container.querySelector('[data-testid="task-chat-live-transcript"]'),
    ).toBeNull();
    expect(
      container.querySelectorAll('[data-testid="task-chat-plan-preview"]'),
    ).toHaveLength(1);
    assertStableOrder();

    render(
      <TaskChatThread
        comments={[
          {
            id: "follow-up-comment",
            companyId: "company-1",
            issueId: "issue-1",
            authorType: "user",
            authorAgentId: null,
            authorUserId: "user-1",
            body: "What about using AI for art generation?",
            presentation: null,
            metadata: null,
            createdAt: new Date("2026-08-23T10:02:00.000Z"),
            updatedAt: new Date("2026-08-23T10:02:00.000Z"),
          },
        ]}
        interactions={[planReviewInteraction("expired")]}
        linkedRuns={[
          {
            runId: "run-plan",
            status: "succeeded",
            agentId: "agent-1",
            agentName: "Runner",
            adapterType: "paperclip_runner",
            createdAt: "2026-08-23T10:00:00.000Z",
            startedAt: "2026-08-23T10:00:00.000Z",
            finishedAt: "2026-08-23T10:01:32.000Z",
            resultJson: null,
          },
        ]}
        onAdd={async () => {}}
        issueId="issue-1"
        issueStatus="in_review"
        activeRun={{
          ...activeRun,
          status: "succeeded",
          finishedAt: "2026-08-23T10:01:32.000Z",
        }}
      />,
    );

    const expiredText = container.textContent ?? "";
    expect(
      container.querySelectorAll('[data-testid="task-chat-plan-preview"]'),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-testid="plan-review-preview"]'),
    ).toBeNull();
    expect(expiredText.indexOf("Preview the Plan")).toBeLessThan(
      expiredText.indexOf("What about using AI for art generation?"),
    );
    expect(
      expiredText.indexOf("What about using AI for art generation?"),
    ).toBeLessThan(expiredText.indexOf("Confirmation expired after comment"));
    assertStableOrder();
  });

  it.each(["acpx_local", "claude_local", "codex_local"])(
    "keeps a %s Plan at its durable timestamp through confirmation and successor runs",
    (adapterType) => {
      planState.data = planDocument();
      transcriptState.transcriptByRun.set("legacy-plan-run", [
        {
          kind: "assistant",
          ts: "2026-08-23T10:00:30.000Z",
          text: "Preparing the legacy plan.",
          channel: "progress",
        },
        {
          kind: "tool_call",
          ts: "2026-08-23T10:00:59.000Z",
          name: "curl -X PUT /api/issues/issue-1/documents/plan",
          toolUseId: "legacy-write-plan",
          input: {},
        },
        {
          kind: "tool_result",
          ts: "2026-08-23T10:01:00.250Z",
          toolUseId: "legacy-write-plan",
          toolName: "curl",
          content: "Revision 3 saved",
          isError: false,
        },
        {
          kind: "assistant",
          ts: "2026-08-23T10:01:02.000Z",
          text: "The legacy plan is ready for review.",
          channel: "progress",
        },
      ]);
      transcriptState.transcriptByRun.set("successor-run", [
        {
          kind: "assistant",
          ts: "2026-08-23T10:02:05.000Z",
          text: "Unexpected successor run.",
          channel: "progress",
        },
      ]);

      const legacyRun = {
        id: "legacy-plan-run",
        status: "running" as const,
        invocationSource: "assignment" as const,
        triggerDetail: null,
        startedAt: "2026-08-23T10:00:00.000Z",
        finishedAt: null,
        createdAt: "2026-08-23T10:00:00.000Z",
        agentId: "agent-1",
        agentName: "Legacy planner",
        adapterType,
      };
      const assertLegacyPlanPosition = () => {
        const text = container.textContent ?? "";
        expect(
          container.querySelectorAll(
            '[data-testid="task-chat-plan-preview"]',
          ),
        ).toHaveLength(1);
        expect(
          container.querySelector('[data-testid="plan-review-preview"]'),
        ).toBeNull();
        expect(text.indexOf("Preparing the legacy plan.")).toBeLessThan(
          text.indexOf("Preview the Plan"),
        );
        expect(text.indexOf("Preview the Plan")).toBeLessThan(
          text.indexOf("The legacy plan is ready for review."),
        );
      };

      render(
        <TaskChatThread
          comments={[]}
          interactions={[
            planReviewInteraction("pending", "revision-3", null),
          ]}
          onAdd={async () => {}}
          issueId="issue-1"
          issueStatus="in_progress"
          activeRun={legacyRun}
        />,
      );
      assertLegacyPlanPosition();

      const settledRun = {
        runId: "legacy-plan-run",
        status: "succeeded" as const,
        agentId: "agent-1",
        agentName: "Legacy planner",
        adapterType,
        createdAt: "2026-08-23T10:00:00.000Z",
        startedAt: "2026-08-23T10:00:00.000Z",
        finishedAt: "2026-08-23T10:01:30.000Z",
        resultJson: null,
      };
      render(
        <TaskChatThread
          comments={[]}
          interactions={[
            planReviewInteraction(
              "pending",
              "revision-3",
              "legacy-plan-run",
            ),
          ]}
          linkedRuns={[settledRun]}
          onAdd={async () => {}}
          issueId="issue-1"
          issueStatus="in_review"
          activeRun={{
            ...legacyRun,
            status: "succeeded",
            finishedAt: "2026-08-23T10:01:30.000Z",
          }}
        />,
      );
      assertLegacyPlanPosition();

      render(
        <TaskChatThread
          comments={[]}
          interactions={[
            planReviewInteraction(
              "pending",
              "revision-3",
              "legacy-plan-run",
            ),
          ]}
          linkedRuns={[settledRun]}
          onAdd={async () => {}}
          issueId="issue-1"
          issueStatus="in_review"
          activeRun={{
            ...legacyRun,
            id: "successor-run",
            status: "running",
            invocationSource: "automation",
            startedAt: "2026-08-23T10:02:00.000Z",
            createdAt: "2026-08-23T10:02:00.000Z",
          }}
        />,
      );
      assertLegacyPlanPosition();
      expect((container.textContent ?? "").indexOf("Preview the Plan")).toBeLessThan(
        (container.textContent ?? "").indexOf("Unexpected successor run."),
      );
    },
  );

  it("keeps a yielded review summary in place through the live-to-settled handoff", () => {
    transcriptState.transcriptByRun.set("run-plan", [
      {
        kind: "assistant",
        ts: "2026-08-24T22:27:30.000Z",
        text: "The plan document is published.",
        channel: "progress",
      },
      {
        kind: "tool_call",
        ts: "2026-08-24T22:27:35.000Z",
        name: "get_document",
        toolUseId: "read-plan",
        input: { key: "plan" },
      },
      {
        kind: "tool_result",
        ts: "2026-08-24T22:27:36.000Z",
        toolUseId: "read-plan",
        toolName: "get_document",
        content: "Revision verified",
        isError: false,
      },
      {
        kind: "run_result",
        ts: "2026-08-24T22:27:42.000Z",
        disposition: "yielded",
        summary: "Waiting for Review browser RTS plan.",
        objectiveSatisfied: false,
        verification: [],
        remainingWork: [
          {
            description: "Resume after the review is resolved.",
            blocksCompletion: true,
          },
        ],
        blocker: null,
        artifacts: [],
      },
    ]);
    const activeRun = {
      id: "run-plan",
      status: "running" as const,
      invocationSource: "issue" as const,
      triggerDetail: null,
      startedAt: "2026-08-24T22:24:55.000Z",
      finishedAt: null,
      createdAt: "2026-08-24T22:24:55.000Z",
      agentId: "agent-1",
      agentName: "Runner",
      adapterType: "paperclip_runner",
    };

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={activeRun}
      />,
    );
    expect(
      container.textContent?.match(/Waiting for Review browser RTS plan\./g),
    ).toHaveLength(1);

    render(
      <TaskChatThread
        comments={[]}
        interactions={[planReviewInteraction("pending")]}
        linkedRuns={[
          {
            runId: "run-plan",
            status: "succeeded",
            agentId: "agent-1",
            agentName: "Runner",
            adapterType: "paperclip_runner",
            createdAt: "2026-08-24T22:24:55.000Z",
            startedAt: "2026-08-24T22:24:55.000Z",
            finishedAt: "2026-08-24T22:27:42.000Z",
            resultJson: {
              semanticResult: {
                result: {
                  schema: "paperclip.run_result.v1",
                  reportedWorkDisposition: "yielded",
                  summary: "Waiting for Review browser RTS plan.",
                  verification: [],
                },
              },
              presentationDecision: {
                schema: "paperclip.run_presentation_decision.v1",
                chosenSource: "none",
                activityDisposition: "collapse",
              },
            },
          },
        ]}
        onAdd={async () => {}}
        issueStatus="in_review"
        activeRun={{
          ...activeRun,
          status: "succeeded",
          finishedAt: "2026-08-24T22:27:42.000Z",
        }}
      />,
    );

    const text = container.textContent ?? "";
    expect(text.match(/Waiting for Review browser RTS plan\./g)).toHaveLength(
      1,
    );
    expect(text).not.toContain("returned no user-facing response");
    expect(text.indexOf("The plan document is published.")).toBeLessThan(
      text.indexOf("Waiting for Review browser RTS plan."),
    );
    const settledIdentity = container.querySelector(
      '[data-testid="task-chat-turn-summary"]',
    );
    expect(settledIdentity?.textContent).toContain("Runner");
    expect(settledIdentity?.textContent).toContain("Worked for");
    expect(
      settledIdentity?.querySelector('[data-testid="task-chat-agent-avatar"]'),
    ).not.toBeNull();
    expect(settledIdentity?.getAttribute("data-turn-position")).toBe(
      "identity",
    );
    expect(settledIdentity?.classList.contains("border-b")).toBe(false);
    expect(
      container.querySelector('[data-testid="task-chat-live-transcript"]'),
    ).toBeNull();
  });
});

describe("TaskChatThread native-runner failures", () => {
  it("replaces an empty failed transcript with actionable retry feedback and keeps the composer enabled", () => {
    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        linkedRuns={[
          {
            runId: "run-failed",
            status: "failed",
            agentId: "agent-1",
            adapterType: "paperclip-runner",
            createdAt: "2026-08-21T12:00:00.000Z",
            startedAt: "2026-08-21T12:00:00.000Z",
            finishedAt: "2026-08-21T12:00:01.000Z",
            errorCode: "provider_frame_too_large",
            hasStoredOutput: false,
          },
        ]}
      />,
    );

    expect(container.textContent).toContain("Run failed");
    expect(container.textContent).toContain(
      "Provider output exceeded the safe limit",
    );
    expect(container.textContent).not.toContain("Waiting for transcript");
    expect(container.querySelector("textarea")?.disabled ?? false).toBe(false);
  });

  it("adds Try again to the latest failed-run banner for a blocked recovery", async () => {
    const onTryAgain = vi.fn();
    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="blocked"
        onTryAgainNoLiveExecutionPath={onTryAgain}
        linkedRuns={[
          {
            runId: "run-failed",
            status: "failed",
            agentId: "agent-1",
            adapterType: "acpx",
            createdAt: "2026-08-21T12:00:00.000Z",
            startedAt: "2026-08-21T12:00:00.000Z",
            finishedAt: "2026-08-21T12:00:01.000Z",
            errorCode: "acpx_turn_failed",
            hasStoredOutput: false,
          },
        ]}
      />,
    );

    const tryAgain = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-run-failed-try-again"]',
    );
    expect(tryAgain?.textContent).toBe("Try again");
    flushSync(() => tryAgain!.click());
    await Promise.resolve();
    expect(onTryAgain).toHaveBeenCalledTimes(1);
  });
});

describe("TaskChatThread composer alignment (PAP-498)", () => {
  it("matches the thread width on mobile and stays narrower on larger screens", () => {
    render(<TaskChatThread comments={[]} onAdd={async () => {}} />);

    const dock = container
      .querySelector('[data-testid="mock-editor"]')
      ?.closest("div.sticky") as HTMLElement | null;

    expect(dock?.className).toContain("w-full");
    expect(dock?.className).toContain("max-w-(--tc-shell-max-w)");
    expect(dock?.className).not.toContain("md:w-(--pct-80)");
  });
});

describe("TaskChatThread no-live-execution-path recovery", () => {
  const noLivePathComment = {
    id: "comment-no-live-path",
    companyId: "company-1",
    issueId: "issue-1",
    authorType: "system" as const,
    authorAgentId: null,
    authorUserId: null,
    body: "Paperclip retried continuation, but it still has no live execution path.",
    presentation: {
      kind: "system_notice" as const,
      tone: "danger" as const,
      title: "No live execution path",
      detailsDefaultOpen: false,
    },
    metadata: null,
    createdAt: new Date("2026-08-26T12:00:00.000Z"),
    updatedAt: new Date("2026-08-26T12:00:00.000Z"),
  };

  it("offers Try again only while the task is blocked", async () => {
    const onTryAgain = vi.fn();
    const props = {
      comments: [noLivePathComment],
      onAdd: async () => {},
      onTryAgainNoLiveExecutionPath: onTryAgain,
      showComposer: false,
    };

    render(<TaskChatThread {...props} issueStatus="blocked" />);
    const tryAgain = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-no-live-path-try-again"]',
    );
    expect(tryAgain).not.toBeNull();

    flushSync(() => tryAgain!.click());
    await Promise.resolve();
    expect(onTryAgain).toHaveBeenCalledTimes(1);

    render(<TaskChatThread {...props} issueStatus="todo" />);
    expect(container.querySelector('[data-testid="task-chat-no-live-path-try-again"]')).toBeNull();
  });
});

describe("TaskChatThread blocker links", () => {
  it("shows the direct and server-selected terminal blocker at the top and bottom", () => {
    const terminalBlocker = {
      id: "terminal-2",
      identifier: "PAP-777",
      title: "Actual work",
      status: "in_progress" as const,
      priority: "high" as const,
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
    };
    const directBlocker = {
      id: "direct-2",
      identifier: "PAP-600",
      title: "Waiting in review",
      status: "in_review" as const,
      priority: "medium" as const,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      terminalBlockers: [terminalBlocker],
    };

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="blocked"
        blockedBy={[
          {
            id: "direct-1",
            identifier: "PAP-500",
            title: "Different dependency",
            status: "todo",
            priority: "low",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
          directBlocker,
        ]}
        blockerAttention={{
          state: "needs_attention",
          reason: "attention_required",
          unresolvedBlockerCount: 2,
          coveredBlockerCount: 0,
          stalledBlockerCount: 0,
          attentionBlockerCount: 1,
          sampleBlockerIdentifier: "PAP-777",
          sampleStalledBlockerIdentifier: null,
          terminalBlockerIssueId: terminalBlocker.id,
        }}
      />,
    );

    const notices = container.querySelectorAll(
      '[data-testid="task-chat-blocker-links"]',
    );
    expect(notices).toHaveLength(2);
    expect(notices[0]?.getAttribute("data-placement")).toBe("top");
    expect(notices[1]?.getAttribute("data-placement")).toBe("bottom");
    for (const notice of notices) {
      expect(notice.textContent).toContain(
        "Blocked byPAP-600Waiting in review",
      );
      expect(notice.textContent).toContain(
        "Ultimately blocked byPAP-777Actual work",
      );
      expect(notice.querySelector('a[href="/issues/PAP-600"]')).not.toBeNull();
      expect(notice.querySelector('a[href="/issues/PAP-777"]')).not.toBeNull();
    }
    expect(container.textContent).not.toContain("Different dependency");
    expect(container.textContent).not.toContain(
      "This task resumes automatically",
    );
  });

  it("shows the ordered live-work queue at the top and bottom", () => {
    const terminalBlocker = {
      id: "terminal-running",
      identifier: "PAP-17426",
      title: "Restore live alias projection",
      status: "in_progress" as const,
      priority: "high" as const,
      assigneeAgentId: "agent-3",
      assigneeUserId: null,
    };

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="blocked"
        liveIssueIds={new Set(["direct-running", "terminal-running"])}
        blockerAttention={{
          state: "covered",
          reason: "active_dependency",
          unresolvedBlockerCount: 2,
          coveredBlockerCount: 2,
          stalledBlockerCount: 0,
          attentionBlockerCount: 0,
          sampleBlockerIdentifier: "PAP-17426",
          sampleStalledBlockerIdentifier: null,
          blockingTreeLive: true,
          directBlockerIssueId: "direct-running",
          terminalBlockerIssueId: terminalBlocker.id,
          terminalBlocker,
        }}
        blockedBy={[
          {
            id: "direct-queued",
            identifier: "PAP-17427",
            title: "Verify the completed projection",
            status: "todo",
            priority: "medium",
            assigneeAgentId: "agent-4",
            assigneeUserId: null,
          },
          {
            id: "direct-running",
            identifier: "PAP-17425",
            title: "Verify the live projection",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: "agent-2",
            assigneeUserId: null,
            terminalBlockers: [terminalBlocker],
          },
          {
            id: "direct-done",
            identifier: "PAP-17424",
            title: "Run the guarded cutover",
            status: "done",
            priority: "medium",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
          },
        ]}
      />,
    );

    const notices = container.querySelectorAll(
      '[data-testid="task-chat-live-work-links"]',
    );
    expect(notices).toHaveLength(2);
    expect(notices[0]?.getAttribute("data-placement")).toBe("top");
    expect(notices[1]?.getAttribute("data-placement")).toBe("bottom");
    for (const notice of notices) {
      expect(notice.textContent).toContain("Waiting on live work");
      const orderedLinks = [
        ...notice.querySelectorAll(
          '[data-testid="task-chat-live-work-step"] a',
        ),
      ].map((link) => link.textContent);
      expect(orderedLinks).toEqual([
        "PAP-17424Run the guarded cutover",
        "PAP-17425Verify the live projection",
        "PAP-17427Verify the completed projection",
      ]);
      expect(notice.textContent).toContain(
        "Now runningPAP-17426Restore live alias projection",
      );
      expect(
        notice.querySelector('a[href="/issues/PAP-17426"]'),
      ).not.toBeNull();
    }
    expect(
      container.querySelector('[data-testid="task-chat-blocker-links"]'),
    ).toBeNull();
  });

  it("keeps the compact blocker rows when covered work is no longer live", () => {
    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="blocked"
        liveIssueIds={new Set()}
        blockerAttention={{
          state: "covered",
          reason: "active_dependency",
          unresolvedBlockerCount: 1,
          coveredBlockerCount: 1,
          stalledBlockerCount: 0,
          attentionBlockerCount: 0,
          sampleBlockerIdentifier: "PAP-500",
          sampleStalledBlockerIdentifier: null,
          blockingTreeLive: false,
        }}
        blockedBy={[
          {
            id: "direct-1",
            identifier: "PAP-500",
            title: "Direct dependency",
            status: "todo",
            priority: "medium",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
          },
        ]}
      />,
    );

    expect(
      container.querySelector('[data-testid="task-chat-live-work-links"]'),
    ).toBeNull();
    expect(
      container.querySelectorAll('[data-testid="task-chat-blocker-links"]'),
    ).toHaveLength(2);
  });

  it("shows only the direct row when the blocker has no deeper unresolved leaf", () => {
    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="blocked"
        blockedBy={[
          {
            id: "direct-1",
            identifier: "PAP-500",
            title: "Direct dependency",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
          },
        ]}
      />,
    );

    expect(
      container.querySelectorAll('[data-testid="task-chat-blocker-links"]'),
    ).toHaveLength(2);
    expect(container.textContent).toContain(
      "Blocked byPAP-500Direct dependency",
    );
    expect(container.textContent).not.toContain("Ultimately blocked by");
  });

  it("keeps a server-selected intermediate blocker on its direct chain", () => {
    const selectedIntermediate = {
      id: "intermediate-2",
      identifier: "PAP-650",
      title: "Stalled intermediate review",
    };
    const selectedDirect = {
      id: "direct-2",
      identifier: "PAP-600",
      title: "Selected dependency",
      status: "blocked" as const,
      priority: "medium" as const,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      terminalBlockers: [
        {
          id: "leaf-2",
          identifier: "PAP-700",
          title: "Deeper structural leaf",
          status: "todo" as const,
          priority: "medium" as const,
          assigneeAgentId: "agent-2",
          assigneeUserId: null,
        },
      ],
    };

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="blocked"
        blockedBy={[
          {
            id: "direct-1",
            identifier: "PAP-500",
            title: "Unrelated dependency",
            status: "todo",
            priority: "low",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
          selectedDirect,
        ]}
        blockerAttention={{
          state: "stalled",
          reason: "stalled_review",
          unresolvedBlockerCount: 2,
          coveredBlockerCount: 0,
          stalledBlockerCount: 1,
          attentionBlockerCount: 1,
          sampleBlockerIdentifier: "PAP-650",
          sampleStalledBlockerIdentifier: "PAP-650",
          directBlockerIssueId: selectedDirect.id,
          terminalBlockerIssueId: selectedIntermediate.id,
          terminalBlocker: selectedIntermediate,
        }}
      />,
    );

    for (const notice of container.querySelectorAll(
      '[data-testid="task-chat-blocker-links"]',
    )) {
      expect(notice.textContent).toContain(
        "Blocked byPAP-600Selected dependency",
      );
      expect(notice.textContent).toContain(
        "Ultimately blocked byPAP-650Stalled intermediate review",
      );
    }
    expect(container.textContent).not.toContain("Unrelated dependency");
    expect(container.textContent).not.toContain("Deeper structural leaf");
  });

  it("auto-follows the new bottom blocker row when a pinned thread becomes blocked", () => {
    const comment = {
      id: "comment-1",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "user" as const,
      authorAgentId: null,
      authorUserId: "user-1",
      body: "Waiting for the dependency.",
      presentation: null,
      metadata: null,
      createdAt: new Date("2026-08-15T12:00:00.000Z"),
      updatedAt: new Date("2026-08-15T12:00:00.000Z"),
    };
    const directBlocker = {
      id: "direct-1",
      identifier: "PAP-500",
      title: "Direct dependency",
      status: "in_progress" as const,
      priority: "medium" as const,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
    };
    const baseProps = {
      comments: [comment],
      onAdd: async () => {},
      blockedBy: [directBlocker],
    };

    render(<TaskChatThread {...baseProps} issueStatus="in_progress" />);
    const scroller = container.querySelector<HTMLElement>(
      '[data-testid="task-chat-scroller"]',
    )!;
    fakeScrollGeometry(scroller);

    render(<TaskChatThread {...baseProps} issueStatus="blocked" />);

    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
  });

  it("does not show blocker rows outside the blocked state", () => {
    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        blockedBy={[
          {
            id: "direct-1",
            identifier: "PAP-500",
            title: "Direct dependency",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
          },
        ]}
      />,
    );

    expect(
      container.querySelector('[data-testid="task-chat-blocker-links"]'),
    ).toBeNull();
  });
});

describe("TaskChatThread queued message actions", () => {
  it("interrupts the exact run that a persisted queued message is waiting behind", () => {
    const onInterruptQueued = vi.fn(async () => {});
    const queuedComment = {
      id: "comment-queued",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "user" as const,
      authorAgentId: null,
      authorUserId: "user-1",
      body: "Use the latest requirements instead.",
      presentation: null,
      metadata: null,
      queueState: "queued" as const,
      queueTargetRunId: "run-active",
      createdAt: new Date("2026-08-14T12:00:00.000Z"),
      updatedAt: new Date("2026-08-14T12:00:00.000Z"),
    };

    render(
      <TaskChatThread
        comments={[queuedComment]}
        onAdd={async () => {}}
        onInterruptQueued={onInterruptQueued}
      />,
    );

    const interrupt = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Interrupt",
    );
    expect(container.textContent).toContain("Queued");
    expect(interrupt).not.toBeUndefined();

    flushSync(() => interrupt!.click());
    expect(onInterruptQueued).toHaveBeenCalledOnce();
    expect(onInterruptQueued).toHaveBeenCalledWith("run-active");
  });

  it("disables the action while the queued run is being interrupted", () => {
    render(
      <TaskChatThread
        comments={[
          {
            id: "comment-queued",
            companyId: "company-1",
            issueId: "issue-1",
            authorType: "user",
            authorAgentId: null,
            authorUserId: "user-1",
            body: "Use the latest requirements instead.",
            presentation: null,
            metadata: null,
            clientStatus: "queued",
            queueTargetRunId: "run-active",
            createdAt: new Date("2026-08-14T12:00:00.000Z"),
            updatedAt: new Date("2026-08-14T12:00:00.000Z"),
          },
        ]}
        onAdd={async () => {}}
        onInterruptQueued={async () => {}}
        interruptingQueuedRunId="run-active"
      />,
    );

    const interrupting = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Interrupting…",
    );
    expect(interrupting).not.toBeUndefined();
    expect(interrupting?.disabled).toBe(true);
  });
});

describe("TaskChatThread Paperclip Runner queue", () => {
  const queuedComment = {
    id: "queued-prp-1",
    companyId: "company-1",
    issueId: "issue-1",
    authorType: "user" as const,
    authorAgentId: null,
    authorUserId: "user-1",
    body: "Render this queued message exactly once.",
    presentation: null,
    metadata: null,
    createdAt: new Date("2026-08-22T15:00:00.000Z"),
    updatedAt: new Date("2026-08-22T15:00:00.000Z"),
  };
  const queue: IssueQueuedCommentQueue = {
    issueId: "issue-1",
    queueId: "wake-1",
    state: "deferred",
    targetRunId: "run-1",
    revision: "revision-1",
    protocol: "paperclip_runner_v1",
    steeringDisposition: "available",
    entries: [
      { comment: queuedComment, position: 0, canEdit: true, canDiscard: true },
    ],
  };

  function occurrenceCount(text: string) {
    return container.textContent?.split(text).length! - 1;
  }

  it("suppresses the transcript echo until the queued entry is consumed", async () => {
    const props = {
      comments: [queuedComment],
      onAdd: async () => {},
      queuedCommentQueue: queue,
      onEditQueuedComment: async () => {},
      onReorderQueuedComments: async () => {},
      onSteerQueuedComment: async () => {},
      onDiscardQueuedComment: async () => {},
    };
    render(<TaskChatThread {...props} />);

    const stack = container.querySelector(
      '[data-testid="task-chat-composer-stack"]',
    );
    const queuePane = container.querySelector(
      '[data-testid="task-chat-queued-messages"]',
    );
    expect(queuePane?.parentElement).toBe(stack);
    expect(stack?.classList).not.toContain("gap-2");
    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-message-queued-prp-1"]',
      ),
    ).not.toBeNull();
    expect(occurrenceCount(queuedComment.body)).toBe(1);

    await act(async () => {
      render(
        <TaskChatThread
          {...props}
          queuedCommentQueue={{ ...queue, revision: "revision-2", entries: [] }}
        />,
      );
      await Promise.resolve();
    });

    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-message-queued-prp-1"]',
      ),
    ).toBeNull();
    expect(occurrenceCount(queuedComment.body)).toBe(1);
  });
});

describe("TaskChatThread mobile composer dock (PAP-495)", () => {
  it("pins the composer to the nav-aware bottom offset so its action row clears the auto-hiding bottom nav", () => {
    sidebarState.isMobile = true;

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        draftKey="task-chat-draft:issue-mobile"
      />,
    );

    const dock = container
      .querySelector('[data-testid="mock-editor"]')
      ?.closest("div.sticky") as HTMLElement | null;

    expect(dock).not.toBeNull();
    // Bottom offset comes from --tc-composer-bottom (Layout raises it to the nav
    // height while the nav is on screen) — NOT the raw safe-area dock, which is
    // what let the nav occlude the action row before PAP-495.
    expect(dock?.className).toContain("bottom-(--tc-composer-bottom)");
    expect(dock?.className).not.toContain("bottom-(--sz-calc-8)");
  });
});

describe("TaskChatThread live transcript", () => {
  it("places the turn status island below composer accessories and hides it when the turn is terminal", () => {
    transcriptState.transcriptByRun.set("run-status", [
      {
        kind: "provider_activity",
        ts: "2026-08-24T12:00:01.000Z",
        family: "plan",
        eventType: "plan.updated",
        status: "running",
        title: "Plan",
        payload: {
          planId: "turn-1",
          steps: [
            { stepId: "one", body: "Inspect", status: "completed" },
            { stepId: "two", body: "Build", status: "in_progress" },
          ],
        },
      },
      {
        kind: "workspace_change",
        ts: "2026-08-24T12:00:02.000Z",
        changeSetId: "turn-1:workspace",
        revision: 1,
        source: "harness_reported",
        complete: false,
        files: [
          {
            path: "ui/src/App.tsx",
            operation: "modify",
            previousPath: null,
            additions: 4,
            deletions: 1,
            binary: false,
            diff: null,
          },
        ],
        totals: { files: 1, additions: 4, deletions: 1 },
        patchArtifactRef: null,
      },
    ]);
    const activeRun = {
      id: "run-status",
      status: "running" as const,
      invocationSource: "issue" as const,
      triggerDetail: null,
      startedAt: "2026-08-24T12:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-08-24T12:00:00.000Z",
      agentId: "agent-1",
      agentName: "Codex",
      adapterType: "paperclip_runner",
    };

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={activeRun}
        composerAccessory={<div data-testid="composer-accessory">Monitor</div>}
      />,
    );

    const dock = container.querySelector(
      '[data-testid="task-chat-composer-dock"]',
    )!;
    const accessory = container.querySelector(
      '[data-testid="composer-accessory"]',
    )!;
    const island = container.querySelector(
      '[data-testid="task-chat-turn-status-island"]',
    )!;
    const stack = container.querySelector(
      '[data-testid="task-chat-composer-stack"]',
    )!;
    expect(island.textContent).toContain("Step 2 / 2");
    expect(island.textContent).toContain("1 file changed");
    expect(accessory.compareDocumentPosition(island)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(island.compareDocumentPosition(stack)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(dock.contains(island)).toBe(true);

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={{
          ...activeRun,
          status: "succeeded",
          finishedAt: "2026-08-24T12:01:00.000Z",
        }}
      />,
    );
    expect(
      container.querySelector('[data-testid="task-chat-turn-status-island"]'),
    ).toBeNull();
  });

  it("keeps an unlinked persisted runner reply hidden while the live turn still owns that response", () => {
    transcriptState.transcriptByRun.set("run-runner", [
      {
        kind: "assistant",
        ts: "2026-08-21T15:44:20.000Z",
        text: "Completed the requested streaming test.",
        channel: "final",
        delta: true,
      },
    ]);
    const comment = {
      id: "comment-runner",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "agent" as const,
      authorAgentId: "agent-1",
      authorUserId: null,
      body: "Completed the requested streaming test.",
      presentation: null,
      metadata: null,
      runId: null,
      createdAt: new Date("2026-08-21T15:44:22.000Z"),
      updatedAt: new Date("2026-08-21T15:44:22.000Z"),
    };

    render(
      <TaskChatThread
        comments={[comment]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={{
          id: "run-runner",
          status: "running",
          invocationSource: "issue",
          triggerDetail: null,
          startedAt: "2026-08-21T15:44:00.000Z",
          finishedAt: null,
          createdAt: "2026-08-21T15:44:00.000Z",
          agentId: "agent-1",
          agentName: "Runner",
          adapterType: "paperclip_runner",
        }}
      />,
    );

    expect(
      container.textContent?.match(/Completed the requested streaming test\./g),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-testid="task-chat-agent-bubble"]'),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-testid="task-chat-live-transcript"]'),
    ).not.toBeNull();
  });

  it("surfaces the live runtime status while no transcript has streamed yet", () => {
    // Sandbox runs spend their first minutes in preparation phases (config
    // seed, workspace sync) with zero transcript entries. The tail must show
    // the run's runtime-progress status instead of an opaque wait message.
    const baseRun = {
      id: "run-prep",
      status: "running" as const,
      invocationSource: "issue" as const,
      triggerDetail: null,
      startedAt: "2026-08-07T00:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-08-07T00:00:00.000Z",
      agentId: "agent-1",
      agentName: "Coder",
      adapterType: "claude_local",
    };

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={{
          ...baseRun,
          currentStatusMessage: "Syncing workspace to environment",
        }}
      />,
    );

    const tail = container.querySelector(
      '[data-testid="task-chat-live-transcript"]',
    );
    expect(tail).not.toBeNull();
    expect(tail!.textContent).toContain("Syncing workspace to environment");
    expect(tail!.textContent).not.toContain("Waiting for transcript...");

    // Without a runtime status, the generic wait message still shows.
    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={{ ...baseRun, id: "run-prep-2" }}
      />,
    );
    const tail2 = container.querySelector(
      '[data-testid="task-chat-live-transcript"]',
    );
    expect(tail2!.textContent).toContain("Waiting for transcript...");
  });

  it("renders in-flight output through TaskChatLiveTail, dropping the debug plumbing (PAP-463 C1)", () => {
    // Interleave the exact noise the old RunTranscriptView tail surfaced (init
    // row, stdout/stderr/system dumps) with real content. Only the streamed
    // reply markdown and the tool row may reach the thread.
    transcriptState.transcriptByRun.set("run-1", [
      {
        kind: "init",
        ts: "2026-08-07T00:00:00.000Z",
        model: "claude",
        sessionId: "sess-INITMARKER",
      },
      {
        kind: "system",
        ts: "2026-08-07T00:00:00.000Z",
        text: "SYSTEMNOISE environment hint",
      },
      {
        kind: "stdout",
        ts: "2026-08-07T00:00:00.000Z",
        text: "STDOUTNOISE raw json dump",
      },
      {
        kind: "stderr",
        ts: "2026-08-07T00:00:00.000Z",
        text: "STDERRNOISE adapter timeout note",
      },
      {
        kind: "assistant",
        ts: "2026-08-07T00:00:00.000Z",
        text: "Streaming through the shared renderer",
      },
      {
        kind: "tool_call",
        ts: "2026-08-07T00:00:00.000Z",
        name: "Read",
        toolUseId: "t1",
        input: { file_path: "src/app.ts" },
      },
    ]);

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={{
          id: "run-1",
          status: "running",
          invocationSource: "issue",
          triggerDetail: null,
          startedAt: "2026-08-07T00:00:00.000Z",
          finishedAt: null,
          createdAt: "2026-08-07T00:00:00.000Z",
          agentId: "agent-1",
          agentName: "Coder",
          adapterType: "codex_local",
        }}
      />,
    );

    const tail = container.querySelector(
      '[data-testid="task-chat-live-transcript"]',
    );
    expect(tail).not.toBeNull();
    // Clean content survives: streamed reply markdown + compact phase summary.
    expect(tail!.textContent).toContain(
      "Streaming through the shared renderer",
    );
    const phaseSummary = tail!.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-phase-summary"]',
    );
    expect(phaseSummary?.getAttribute("aria-expanded")).toBe("true");
    expect(tail!.textContent).toContain("src/app.ts");
    // None of the debug plumbing reaches the thread.
    for (const noise of [
      "INITMARKER",
      "SYSTEMNOISE",
      "STDOUTNOISE",
      "STDERRNOISE",
    ]) {
      expect(container.textContent).not.toContain(noise);
    }
  });

  it("resolves a visible canonical input even while run adapter metadata is stale", async () => {
    transcriptState.transcriptByRun.set("run-input", [
      {
        kind: "runtime_request",
        ts: "2026-08-23T20:00:00.000Z",
        requestId: "question-1",
        requestKind: "runtime",
        turnId: "turn-1",
        requestType: "input",
        status: "pending",
        prompt: "Codex needs your input.",
        choices: [],
        fields: [],
        questionSet: {
          schema: "paperclip.question_set.v1",
          questions: [
            {
              id: "goal",
              prompt: "What should the server do?",
              required: true,
              answerMode: "single_select",
              options: [{ id: "api", label: "Starter API" }],
            },
          ],
        },
      },
    ]);
    const resolveRuntimeRequest = vi
      .spyOn(heartbeatsApi, "resolveRuntimeRequest")
      .mockResolvedValue({} as never);

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={{
          id: "run-input",
          status: "running",
          invocationSource: "issue",
          triggerDetail: null,
          startedAt: "2026-08-23T20:00:00.000Z",
          finishedAt: null,
          createdAt: "2026-08-23T20:00:00.000Z",
          agentId: "agent-1",
          agentName: "Runner",
          // Reproduces the lag that caused DOT-202: the transcript already has
          // a Paperclip request while the linked-run adapter classification is
          // still stale.
          adapterType: "codex_local",
        }}
      />,
    );

    const option = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Starter API"),
    );
    await act(async () => option?.click());
    const submit = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Submit answers",
    );
    await act(async () => submit?.click());

    expect(resolveRuntimeRequest).toHaveBeenCalledWith({
      runId: "run-input",
      requestId: "question-1",
      turnId: "turn-1",
      requestKind: "runtime",
      resolution: {
        action: "submit",
        response: {
          schema: "paperclip.question_response.v1",
          answers: { goal: { selectedOptionIds: ["api"] } },
        },
      },
    });
    expect(container.textContent).not.toContain("no longer attached");
  });

  it("keeps the transcript mounted through run settle until the settled turn renders (PAP-462 B4)", () => {
    transcriptState.transcriptByRun.set("run-1", [
      {
        kind: "assistant",
        ts: "2026-08-07T00:00:00.000Z",
        text: "Last words before the run stops",
      },
    ]);

    const liveProps = {
      comments: [] as never[],
      onAdd: async () => {},
      issueStatus: "in_progress",
      activeRun: {
        id: "run-1",
        status: "running",
        invocationSource: "issue" as const,
        triggerDetail: null,
        startedAt: "2026-08-07T00:00:00.000Z",
        finishedAt: null,
        createdAt: "2026-08-07T00:00:00.000Z",
        agentId: "agent-1",
        agentName: "Coder",
        adapterType: "codex_local",
      },
    };

    render(<TaskChatThread {...liveProps} />);
    expect(
      container.querySelector('[data-testid="task-chat-live-transcript"]'),
    ).not.toBeNull();

    // The run settles: the issue goes terminal and the run reports succeeded, so
    // `liveRun` flips to null — but no reply comment has landed yet. The
    // transcript must NOT vanish; it stays mounted (now as a settled tail) until
    // its settled turn/comment renders.
    render(
      <TaskChatThread
        {...liveProps}
        issueStatus="done"
        activeRun={{
          ...liveProps.activeRun,
          status: "succeeded",
          finishedAt: "2026-08-07T00:01:00.000Z",
        }}
      />,
    );

    expect(
      container.querySelector('[data-testid="task-chat-live-transcript"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Last words before the run stops");
    // The pill has settled to its "Worked" state rather than flipping back to a
    // spinner while it waits for the reply comment.
    expect(container.textContent).toContain("Worked");
  });
});
