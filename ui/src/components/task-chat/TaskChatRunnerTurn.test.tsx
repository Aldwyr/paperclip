// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { TaskChatRunnerTurn } from "./TaskChatRunnerTurn";
import type { IssueDocument } from "@paperclipai/shared";
import type {
  TaskChatItem,
  TaskChatProviderActivityFamily,
  TaskChatProviderActivityItem,
  TaskChatRuntimeRequestDecision,
  TaskChatRuntimeRequestItem,
} from "./task-chat-model";

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

  const render = (
    items: TaskChatItem[],
    status = "running",
    runId = "run-1",
    onRuntimeRequestDecision?: (item: TaskChatRuntimeRequestItem, decision: TaskChatRuntimeRequestDecision) => void,
    planDocument?: IssueDocument | null,
  ) => act(() => root.render(
    <MemoryRouter>
      <ThemeProvider>
        <TaskChatRunnerTurn runId={runId} agentName="Runner" items={items} status={status} startedAtMs={Date.now() - 2_000} planDocument={planDocument} onRuntimeRequestDecision={onRuntimeRequestDecision} />
      </ThemeProvider>
    </MemoryRouter>,
  ));

  it("shows immediate Thinking before the first runner event", () => {
    render([], "queued");
    expect(container.textContent).toContain("Thinking");
    expect(container.textContent).toContain("Runner");
    expect(container.querySelector('[data-testid="task-chat-runner-disclosure-caret"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-current-activity-icon"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-current-activity-label"]')?.textContent).toBe("Thinking");
    expect(container.querySelector('[data-testid="task-chat-current-activity"]')?.tagName).toBe("DIV");
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

  it("shows whichever provider-authored commentary or reasoning block arrived latest", () => {
    render([
      { id: "commentary", kind: "message", author: "agent", text: "I’ll inspect the card.", interstitial: true, channel: "progress", transcriptIndex: 1 },
      { id: "reasoning", kind: "thinking", lines: ["The saved preview can be reused."], streaming: true, channel: "summary", transcriptIndex: 2 },
    ]);
    expect(container.querySelector('[data-testid="task-chat-reasoning-ticker"]')?.textContent)
      .toContain("The saved preview can be reused.");
    expect(container.querySelector('[data-testid="task-chat-progress-update"]')).toBeNull();

    render([
      { id: "commentary", kind: "message", author: "agent", text: "I’ve found the rendering seam.", interstitial: true, channel: "progress", transcriptIndex: 3 },
      { id: "reasoning", kind: "thinking", lines: ["The saved preview can be reused."], streaming: true, channel: "summary", transcriptIndex: 2 },
    ]);
    expect(container.querySelector('[data-testid="task-chat-reasoning-ticker"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-progress-update"]')?.textContent)
      .toContain("I’ve found the rendering seam.");
  });

  it("appends reasoning fragments in place and animates only a new logical line", () => {
    render([{ id: "reasoning", kind: "thinking", lines: ["Inspect"], streaming: true, transcriptIndex: 1 }]);
    expect(container.querySelector('[data-testid="task-chat-reasoning-ticker"] .cot-line-enter')).toBeNull();

    render([{ id: "reasoning", kind: "thinking", lines: ["Inspecting the runner"], streaming: true, transcriptIndex: 2 }]);
    expect(container.querySelector('[data-testid="task-chat-reasoning-ticker"]')?.textContent).toContain("Inspecting the runner");
    expect(container.querySelector('[data-testid="task-chat-reasoning-ticker"] .cot-line-enter')).toBeNull();

    render([{ id: "reasoning", kind: "thinking", lines: ["Inspecting the runner", "Now testing the stream"], streaming: true, transcriptIndex: 3 }]);
    expect(container.querySelector('[data-testid="task-chat-reasoning-ticker"] .cot-line-enter')?.textContent)
      .toContain("Now testing the stream");
    expect(container.querySelector('[data-testid="task-chat-reasoning-ticker"] .cot-line-exit')?.textContent)
      .toContain("Inspecting the runner");
  });

  it("hides folded narration when expanded and retains every reasoning block in history", () => {
    render([
      { id: "summary", kind: "thinking", lines: ["Inspect the current card."], streaming: false, channel: "summary", transcriptIndex: 1 },
      { id: "detail", kind: "thinking", lines: ["Keep the canonical revision atomic."], streaming: true, channel: "detail", transcriptIndex: 2 },
    ]);
    expect(container.querySelector('[data-testid="task-chat-reasoning-ticker"]')?.textContent)
      .toContain("Keep the canonical revision atomic.");

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="task-chat-current-activity"]')?.click());
    expect(container.querySelector('[data-testid="task-chat-live-narration"]')).toBeNull();
    const history = container.querySelector('[data-testid="task-chat-runner-activity-list"]');
    expect(history?.textContent).toContain("Reasoning");
    expect(history?.textContent).toContain("Reasoning detail");
    expect(history?.querySelectorAll('[data-testid="task-chat-thinking"]')).toHaveLength(2);
  });

  it("lets a lifecycle-only reasoning event replace stale commentary without inventing reasoning text", () => {
    render([
      { id: "commentary", kind: "message", author: "agent", text: "Old commentary", interstitial: true, transcriptIndex: 1 },
      { id: "reasoning", kind: "thinking", lines: [], lifecycleOnly: true, streaming: true, transcriptIndex: 2 },
    ]);
    const narration = container.querySelector('[data-testid="task-chat-live-narration"]');
    expect(narration).not.toBeNull();
    expect(narration?.textContent).toBe("");
    expect(narration?.textContent).not.toContain("Old commentary");
    expect(container.querySelector('[data-testid="task-chat-current-activity-label"]')?.textContent).toBe("Thinking");
  });

  it("streams a provider Plan card and hands off when a canonical revision arrives", () => {
    const activity: TaskChatProviderActivityItem = {
      id: "live-plan",
      kind: "protocol",
      surface: "provider_activity",
      family: "plan",
      eventType: "plan.updated",
      status: "running",
      title: "Plan",
      details: [{ label: "Revision", value: "4" }],
      steps: [{ id: "one", label: "Extract the shared preview", status: "in_progress" }],
      links: [],
      children: [],
      transcriptIndex: 1,
    };
    render([activity]);
    expect(container.querySelector('[data-testid="task-chat-live-plan-preview"]')?.textContent)
      .toContain("Extract the shared preview");

    render([{
      ...activity,
      steps: [
        { id: "one", label: "Extract the shared preview", status: "completed" },
        { id: "two", label: "Stream provider updates", status: "in_progress" },
      ],
      transcriptIndex: 2,
    }]);
    expect(container.querySelectorAll('[data-testid="task-chat-live-plan-preview"]')).toHaveLength(1);
    expect(container.textContent).toContain("Stream provider updates");

    const canonicalPlan = {
      id: "document-plan",
      issueId: "issue-1",
      body: "# Canonical plan",
      latestRevisionId: "revision-4",
      latestRevisionNumber: 4,
      updatedAt: new Date(),
    } as IssueDocument;
    render([activity], "running", "run-1", undefined, canonicalPlan);
    expect(container.querySelector('[data-testid="task-chat-live-plan-preview"]')).toBeNull();
  });

  it("shows canonical web research as the current Codex-style activity", () => {
    render([{
      id: "research-1",
      kind: "protocol",
      surface: "provider_activity",
      family: "research",
      eventType: "research.started",
      status: "running",
      title: "Research",
      summary: "site:openai.com model guide GPT-5.4",
      details: [{ label: "Query", value: "site:openai.com model guide GPT-5.4" }],
      steps: [],
      links: [],
      children: [],
    }]);

    const activity = container.querySelector('[data-testid="task-chat-current-activity"]');
    expect(activity?.textContent).toContain("Searching the web");
    expect(activity?.textContent).toContain("site:openai.com model guide GPT-5.4");
    expect(activity?.getAttribute("data-activity-family")).toBe("research");
  });

  it("has a purpose-built current-activity presentation for every provider family", () => {
    const cases: Array<{
      family: TaskChatProviderActivityFamily;
      eventType: string;
      status: TaskChatProviderActivityItem["status"];
      expected: string;
      details?: TaskChatProviderActivityItem["details"];
    }> = [
      { family: "plan", eventType: "plan.updated", status: "running", expected: "Updating the plan" },
      { family: "tool_execution", eventType: "tool.execution.started", status: "running", expected: "Running a tool" },
      { family: "research", eventType: "research.started", status: "running", expected: "Searching the web", details: [{ label: "Action", value: "search" }] },
      { family: "delegation", eventType: "delegation.started", status: "running", expected: "Starting a subagent", details: [{ label: "Action", value: "spawn" }] },
      { family: "model_identity", eventType: "model.route.changed", status: "informational", expected: "Switched models" },
      { family: "context", eventType: "context.compacted", status: "completed", expected: "Compacted context" },
      { family: "artifact", eventType: "artifact.generated", status: "running", expected: "Generating an artifact" },
      { family: "review", eventType: "review.mode.changed", status: "informational", expected: "Entered review mode", details: [{ label: "State", value: "entered" }] },
      { family: "hook", eventType: "hook.started", status: "running", expected: "Running a hook" },
      { family: "memory", eventType: "memory.citation.referenced", status: "informational", expected: "Referenced memory" },
      { family: "safety", eventType: "safety.review.started", status: "running", expected: "Reviewing safety" },
      { family: "terminal", eventType: "terminal.input.sent", status: "informational", expected: "Sent terminal input" },
      { family: "wait", eventType: "wait.started", status: "running", expected: "Waiting" },
      { family: "provider_notice", eventType: "provider.notice.recorded", status: "informational", expected: "Provider notice" },
    ];

    expect(cases.map((entry) => entry.family)).toEqual([
      "plan", "tool_execution", "research", "delegation", "model_identity", "context", "artifact",
      "review", "hook", "memory", "safety", "terminal", "wait", "provider_notice",
    ] satisfies TaskChatProviderActivityFamily[]);

    for (const entry of cases) {
      render([{
        id: `provider-${entry.family}`,
        kind: "protocol",
        surface: "provider_activity",
        family: entry.family,
        eventType: entry.eventType,
        status: entry.status,
        title: entry.family,
        details: entry.details ?? [],
        steps: [],
        links: [],
        children: [],
      }]);
      const activity = container.querySelector('[data-testid="task-chat-current-activity"]');
      expect(activity?.getAttribute("data-activity-family"), entry.family).toBe(entry.family);
      expect(activity?.textContent, entry.family).toContain(entry.expected);
    }
  });

  it("shows provider failures and interruptions instead of a successful past-tense label", () => {
    const provider = (status: "failed" | "interrupted"): TaskChatProviderActivityItem => ({
      id: `research-${status}`,
      kind: "protocol",
      surface: "provider_activity",
      family: "research",
      eventType: "research.completed",
      status,
      title: "Research",
      details: [],
      steps: [],
      links: [],
      children: [],
    });
    render([provider("failed")]);
    expect(container.querySelector('[data-testid="task-chat-current-activity"]')?.textContent).toContain("Web search failed");
    render([provider("interrupted")]);
    expect(container.querySelector('[data-testid="task-chat-current-activity"]')?.textContent).toContain("Web search stopped");
  });

  it("surfaces workspace changes and file references as current activity", () => {
    render([{
      id: "workspace-change",
      kind: "protocol",
      surface: "workspace_change",
      changeSetId: "change-1",
      revision: 1,
      source: "harness_reported",
      complete: false,
      files: [],
      totals: { files: 2, additions: 3, deletions: 1 },
      patchArtifactRef: null,
    }]);
    expect(container.querySelector('[data-testid="task-chat-current-activity"]')?.textContent).toContain("Editing files");
    expect(container.querySelector('[data-testid="task-chat-current-activity"]')?.textContent).toContain("2 files");

    render([{
      id: "workspace-file",
      kind: "protocol",
      surface: "workspace_file",
      referenceId: "file-1",
      source: "runner_verified",
      path: "ui/src/App.tsx",
      displayName: "App.tsx",
      mediaType: "text/typescript",
      presentation: "code",
      line: 42,
      preview: null,
      previewTruncated: false,
    }]);
    const activity = container.querySelector('[data-testid="task-chat-current-activity"]');
    expect(activity?.textContent).toContain("Referenced a file");
    expect(activity?.textContent).toContain("ui/src/App.tsx:42");
  });

  it("streams the final response in its durable slot and settles the disclosure", () => {
    render([
      { id: "p1", kind: "message", author: "agent", text: "Checking.", interstitial: true, channel: "progress" },
      { id: "f1", kind: "message", author: "agent", authorName: "Runner", text: "Completed successfully.", channel: "final", streaming: true },
    ], "succeeded");
    expect(container.querySelector('[data-testid="task-chat-final-response"]')?.textContent).toContain("Completed successfully.");
    expect(container.querySelectorAll('[data-testid="task-chat-agent-avatar"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="task-chat-current-activity"]')?.textContent).toContain("Worked for");
    expect(container.querySelector('[data-testid="task-chat-current-activity"]')?.getAttribute("aria-expanded")).toBe("false");
  });

  it("collapses terminal reasoning to the existing Worked summary", () => {
    render([
      { id: "reasoning", kind: "thinking", lines: ["Provider-authored trace"], channel: "summary", transcriptIndex: 1 },
    ], "succeeded");
    expect(container.querySelector('[data-testid="task-chat-live-narration"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-current-activity"]')?.textContent).toContain("Worked for");
    expect(container.querySelector('[data-testid="task-chat-current-activity"]')?.getAttribute("aria-expanded")).toBe("false");
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

    expect(container.textContent).not.toContain("Paperclip_finish");
    expect(container.textContent).toContain("Interrupted");
    expect(container.textContent).not.toContain("Session started");
    expect(container.textContent).not.toContain("Turn started");
    expect(container.textContent).not.toContain("Turn completed");
    expect(container.textContent).not.toContain("10,520");
  });

  it("keeps a pending runtime request actionable while the run history is folded", async () => {
    const onDecision = vi.fn();
    render([{
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
    }], "running", "run-1", onDecision);

    const cards = Array.from(container.querySelectorAll('[data-testid="task-chat-runtime-request"]'));
    const visibleCard = cards.find((card) => card.closest(".tc-turn-fold") === null);
    expect(visibleCard).toBeDefined();
    const button = Array.from(visibleCard!.querySelectorAll("button")).find((candidate) => candidate.textContent === "Allow once");
    await act(async () => button?.click());
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ requestId: "request-1" }), { action: "accept" });
  });

  it("keeps a resolved question and answer visible outside folded activity", () => {
    render([{
      id: "resolved-request",
      kind: "protocol",
      surface: "runtime_request",
      runId: "run-1",
      requestId: "request-1",
      requestKind: "runtime",
      turnId: "turn-1",
      requestType: "input",
      status: "resolved",
      prompt: "Codex needs your input.",
      choices: [],
      fields: [],
      questionSet: {
        schema: "paperclip.question_set.v1",
        questions: [{ id: "goal", prompt: "What should the server do?", required: true, answerMode: "text" }],
      },
      response: {
        schema: "paperclip.question_response.v1",
        answers: { goal: { text: "Serve a small JSON API." } },
      },
    }], "succeeded");

    const history = container.querySelector('[data-testid="task-chat-runtime-request-history"]');
    expect(history?.closest(".tc-turn-fold")).toBeNull();
    expect(history?.textContent).toContain("What should the server do?");
    expect(history?.textContent).toContain("Serve a small JSON API.");
  });

  it("expands live semantic activity from the current activity row", () => {
    render([
      { id: "thinking-empty", kind: "thinking", lines: [], streaming: false, lifecycleOnly: true },
      { id: "commentary", kind: "message", author: "agent", text: "Checking the current implementation.", interstitial: true, channel: "progress" },
      { id: "tool", kind: "tool", name: "Read", rawName: "read_file", target: "ui/src/App.tsx", status: "completed", detail: "export function App() {}" },
    ]);

    const disclosure = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-current-activity"]');
    expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".tc-turn-fold")?.hasAttribute("inert")).toBe(true);
    expect(container.querySelector('[data-testid="task-chat-runner-disclosure-caret"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="task-chat-thinking"]')).toHaveLength(0);

    act(() => disclosure?.click());

    expect(disclosure?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".tc-turn-fold")?.hasAttribute("inert")).toBe(false);
    expect(container.querySelector('[data-testid="task-chat-runner-activity-list"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-chat-progress-update"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-activity-commentary"]')?.textContent).toContain("Checking the current implementation.");
    expect(container.textContent).toContain("ui/src/App.tsx");
  });

  it("collapses an open activity list when the run becomes terminal", () => {
    const items: TaskChatItem[] = [{ id: "tool", kind: "tool", name: "Search", rawName: "web_search", target: "smoked pork shoulder", status: "in_progress" }];
    render(items);
    const disclosure = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-current-activity"]');
    act(() => disclosure?.click());
    expect(disclosure?.getAttribute("aria-expanded")).toBe("true");

    render([{ ...items[0], kind: "tool", status: "completed" } as TaskChatItem], "succeeded");

    const settled = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-current-activity"]');
    expect(settled?.getAttribute("aria-expanded")).toBe("false");
    expect(settled?.textContent).toContain("Worked for");
    expect(container.querySelector(".tc-turn-fold")?.getAttribute("data-folded")).toBe("true");
  });

  it("resets the disclosure choice when a different run takes over", () => {
    const items: TaskChatItem[] = [{ id: "tool", kind: "tool", name: "Read", rawName: "read_file", target: "ui/src/App.tsx", status: "completed" }];
    render(items, "running", "run-1");
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="task-chat-current-activity"]')?.click());
    expect(container.querySelector('[data-testid="task-chat-current-activity"]')?.getAttribute("aria-expanded")).toBe("true");

    render(items, "running", "run-2");

    expect(container.querySelector('[data-testid="task-chat-current-activity"]')?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".tc-turn-fold")?.getAttribute("data-folded")).toBe("true");
  });

  it("renders a failed terminal disclosure without treating prose as status authority", () => {
    render([
      { id: "final", kind: "message", author: "agent", text: "I finished the draft.", channel: "final" },
      { id: "tool", kind: "tool", name: "Command", rawName: "bash", target: "pnpm test", status: "failed" },
    ], "failed");

    expect(container.querySelector('[data-testid="task-chat-current-activity"]')?.textContent).toContain("Stopped after");
    expect(container.querySelector('[data-testid="task-chat-final-response"]')?.textContent).toContain("I finished the draft.");
  });
});
