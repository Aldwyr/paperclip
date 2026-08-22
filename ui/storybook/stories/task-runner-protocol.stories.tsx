import { useMemo, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { paperclipRunnerUIAdapter } from "@/adapters/paperclip-runner";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { TaskChatInteractionCard } from "@/components/task-chat/TaskChatInteractionCard";
import { TaskChatThreadView } from "@/components/task-chat/TaskChatThreadView";
import { transcriptToTaskChatItems } from "@/components/task-chat/transcript-adapter";
import type { TaskChatItem, TaskChatRuntimeRequestItem } from "@/components/task-chat/task-chat-model";
import {
  answeredAskUserQuestionsInteraction,
  pendingAskUserQuestionsInteraction,
  pendingRequestCheckboxConfirmationInteraction,
  pendingRequestConfirmationInteraction,
  pendingRequestItemVerdictsInteraction,
  pendingSuggestedTasksInteraction,
  issueThreadInteractionFixtureMeta,
} from "@/fixtures/issueThreadInteractionFixtures";
import { storybookAgentMap } from "../fixtures/paperclipData";

const TS = "2026-08-21T12:00:00.000Z";
const boardUserLabels = new Map([[issueThreadInteractionFixtureMeta.currentUserId, "Riley Board"]]);

function prp(eventType: string, payload: Record<string, unknown>, itemId?: string): string {
  return JSON.stringify({ type: "paperclip.prp.event", event: { eventType, itemId, payload } });
}

function protocolItems(events: string[], running = false): TaskChatItem[] {
  const parser = paperclipRunnerUIAdapter.createStdoutParser!();
  const transcript = events.flatMap((event, index) => parser.parseLine(event, new Date(Date.parse(TS) + index * 1000).toISOString()));
  return transcriptToTaskChatItems(transcript, { runId: "storybook-run", agentName: "Codex", running });
}

const providerEvents = [
  prp("plan.updated", { planId: "plan-1", revision: 3, complete: false, syncStatus: "synchronized", explanation: "Implement the production protocol surfaces.", steps: [
    { stepId: "one", body: "Inventory protocol events", status: "completed" },
    { stepId: "two", body: "Render task-page widgets", status: "in_progress" },
    { stepId: "three", body: "Verify Storybook coverage", status: "pending" },
  ] }),
  prp("tool.execution.completed", { executionId: "exec-1", transport: "process", operation: "execute", name: "pnpm test", target: "ui", status: "completed", durationMs: 8420, exitCode: 0, output: "63 tests passed", outputBytes: 15, outputTruncated: false }),
  prp("research.completed", { researchId: "research-1", action: "search", status: "completed", query: "Paperclip protocol UX", sources: [
    { sourceId: "source-1", title: "Protocol design notes", url: "https://example.com/protocol", snippet: "Provider-neutral interaction guidance." },
  ] }),
  prp("delegation.updated", { delegationId: "delegation-1", action: "spawn", status: "running", children: [
    { childId: "child-1", role: "UI reviewer", model: "gpt-5", status: "completed", summary: "Reviewed interaction states.", activitySummary: "4 files" },
    { childId: "child-2", role: "Test author", model: "gpt-5", status: "running", summary: null, activitySummary: "Writing contract tests" },
  ] }),
  prp("model.route.changed", { routeId: "route-1", provider: "openai", requestedModel: "auto", fromModel: null, effectiveModel: "gpt-5", reason: "Task complexity" }),
  prp("context.compacted", { compactionId: "compact-1", reason: "context_window", preTokens: 112000, postTokens: 48000, sameSession: true }),
  prp("artifact.generated", { artifactId: "artifact-1", status: "completed", reference: "artifacts/protocol-report.md", mediaType: "text/markdown", registered: true, transparentBackground: null, failure: null }),
  prp("review.mode.changed", { reviewId: "review-1", state: "entered", scope: "task changes" }),
  prp("hook.completed", { hookId: "hook-1", event: "post-test", scope: "workspace", status: "completed", blocking: false, durationMs: 320, summary: "Checks recorded" }),
  prp("memory.citation.referenced", { citationId: "citation-1", messageItemId: "message-1", label: "Prior task decision", available: true, reference: "document:architecture" }),
  prp("safety.review.completed", { reviewId: "safety-1", targetExecutionId: "exec-1", status: "completed", decision: "allowed", summary: "No destructive operation detected" }),
  prp("terminal.input.sent", { executionId: "exec-1", origin: "agent", inputClass: "control", byteCount: 1 }),
  prp("wait.started", { waitId: "wait-1", reason: "provider_backoff", status: "running", plannedDurationMs: 2000, elapsedDurationMs: 500 }),
  prp("provider.notice.recorded", { noticeId: "notice-1", level: "warning", code: "rate_limit", message: "Provider throughput is temporarily reduced.", action: "The runner will retry automatically." }),
];

const workspaceEvents = [
  prp("workspace.change.updated", {
    changeSetId: "changes-1", revision: 1, source: "harness_reported", complete: false,
    files: [{ path: "ui/src/App.tsx", operation: "modify", previousPath: null, additions: 2, deletions: 1, binary: false, diff: "@@ -1,2 +1,3 @@\n-old\n+new\n+line" }],
    totals: { files: 1, additions: 2, deletions: 1 }, patchArtifactRef: null,
  }),
  prp("workspace.diff.recorded", {
    changeSetId: "changes-1", revision: 2, source: "runner_verified", complete: true,
    files: [
      { path: "ui/src/App.tsx", operation: "modify", previousPath: null, additions: 2, deletions: 1, binary: false, diff: "@@ -1,2 +1,3 @@\n-old\n+new\n+line" },
      { path: "ui/src/new-card.tsx", operation: "create", previousPath: null, additions: 14, deletions: 0, binary: false, diff: "@@ -0,0 +1,2 @@\n+export function Card() {\n+  return null;\n+}" },
      { path: "ui/public/preview.png", operation: "modify", previousPath: null, additions: null, deletions: null, binary: true, diff: null },
      { path: "ui/src/old.ts", operation: "rename", previousPath: "ui/src/legacy.ts", additions: 0, deletions: 0, binary: false, diff: null },
    ],
    totals: { files: 4, additions: 16, deletions: 1 }, patchArtifactRef: "artifact:patch-1",
  }),
];

const fileReferenceEvent = prp("workspace.file.referenced", {
  referenceId: "reference-1", source: "runner_verified", path: "packages/paperclip-runner/protocol/README.md",
  displayName: "README.md", mediaType: "text/markdown", presentation: "document", line: 42,
  preview: "# Paperclip Runner Protocol\n\nThe runner emits provider-neutral events that the task page renders as durable operator-facing widgets.",
  previewTruncated: false, contentDigest: null,
});

const resultEvents = [
  prp("runtime_request.created", { request: { requestId: "request-1", requestKind: "command_approval", turnId: "turn-1", type: "item/commandExecution/requestApproval", status: "pending", prompt: "Allow the test command to run?", actions: ["accept", "accept_for_session", "decline", "cancel"] } }),
  prp("run.result.proposed", {
    reportedWorkDisposition: "needs_review", summary: "Protocol surfaces are implemented and ready for review.",
    completionClaim: { objectiveSatisfied: true, remainingWork: [{ description: "Review the visual snapshots", blocksCompletion: false }] },
    verification: [{ commandOrCheck: "pnpm --filter @paperclipai/ui typecheck", status: "passed", detail: "No errors" }],
    artifacts: [{ kind: "work_product", ref: "protocol-report", title: "Coverage report" }], attentionRequests: [], evidence: [],
  }),
  prp("run.terminal", { turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "needs_review" }),
];

const runtimeInputEvent = prp("runtime_request.created", {
  request: {
    requestId: "request-input",
    requestKind: "user_input",
    turnId: "turn-1",
    type: "item/tool/requestUserInput",
    status: "pending",
    prompt: "Which environment should the verification target?",
    details: { fields: [{ name: "environment", label: "Environment", placeholder: "staging" }] },
    actions: ["submit", "decline", "cancel"],
  },
});

function TaskPageFrame({ children, composerDisabledReason }: { children: ReactNode; composerDisabledReason?: string }) {
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <section className="mx-auto flex min-h-(--sz-70vh) w-full max-w-(--tc-shell-max-w) flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        {children}
        <div className="border-t border-border bg-background/90 p-3">
          <TaskChatComposer onAdd={() => undefined} workMode="standard" disabled={Boolean(composerDisabledReason)} disabledReason={composerDisabledReason} draftKey="storybook:runner-protocol" />
        </div>
      </section>
    </main>
  );
}

function TaskHeader({ title = "Implement Paperclip protocol coverage" }: { title?: string }) {
  return (
    <header className="flex flex-col gap-2 border-b border-border pb-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">PAP-16679 · In progress</div>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">Codex · Paperclip Runner · default task interface</p>
    </header>
  );
}

function ThreadStory({ items, disabledReason }: { items: TaskChatItem[]; disabledReason?: string }) {
  return <TaskPageFrame composerDisabledReason={disabledReason}><TaskChatThreadView scroll={false} header={<TaskHeader />} items={items} /></TaskPageFrame>;
}

function RuntimeRequestStory() {
  const initial = useMemo(() => protocolItems(resultEvents), []);
  const [items, setItems] = useState(initial);
  const resolve = (request: TaskChatRuntimeRequestItem) => setItems((current) => current.map((item) => item.id === request.id && item.kind === "protocol" && item.surface === "runtime_request" ? { ...item, status: "resolved" } : item));
  return <TaskPageFrame composerDisabledReason="Waiting for a runtime decision"><TaskChatThreadView scroll={false} header={<TaskHeader />} items={items} onRuntimeRequestDecision={resolve} /></TaskPageFrame>;
}

function RuntimeInputStory() {
  const initial = useMemo(() => protocolItems([runtimeInputEvent]), []);
  const [items, setItems] = useState(initial);
  const resolve = (request: TaskChatRuntimeRequestItem) => setItems((current) => current.map((item) => item.id === request.id && item.kind === "protocol" && item.surface === "runtime_request" ? { ...item, status: "resolved" } : item));
  return <TaskPageFrame composerDisabledReason="Waiting for a runtime response"><TaskChatThreadView scroll={false} header={<TaskHeader />} items={items} onRuntimeRequestDecision={resolve} /></TaskPageFrame>;
}

function InteractionStory() {
  const [question, setQuestion] = useState(pendingAskUserQuestionsInteraction);
  const items: TaskChatItem[] = [
    { id: "human", kind: "message", author: "human", text: "Inventory the task-page protocol interactions.", timestamp: "11:58 AM" },
    ...[pendingSuggestedTasksInteraction, pendingRequestConfirmationInteraction, pendingRequestCheckboxConfirmationInteraction, pendingRequestItemVerdictsInteraction, question]
      .map((interaction) => ({ id: `interaction:${interaction.id}`, kind: "interaction" as const, interaction })),
  ];
  return (
    <TaskPageFrame composerDisabledReason="Answer the pending request above to continue">
      <TaskChatThreadView
        scroll={false}
        header={<TaskHeader title="Resolve protocol interactions" />}
        items={items}
        renderInteraction={(item) => (
          <TaskChatInteractionCard
            item={item}
            agentMap={storybookAgentMap}
            currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
            userLabelMap={boardUserLabels}
            onAcceptInteraction={() => undefined}
            onRejectInteraction={() => undefined}
            onSubmitInteractionAnswers={(interaction) => { if (interaction.id === question.id) setQuestion(answeredAskUserQuestionsInteraction); }}
            onCancelInteraction={() => undefined}
            onSubmitInteractionVerdicts={() => undefined}
          />
        )}
      />
    </TaskPageFrame>
  );
}

const meta = {
  title: "Task Page/Runner Protocol",
  component: TaskChatThreadView,
  args: { items: [] },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TaskChatThreadView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ProviderSemantics: Story = { render: () => <ThreadStory items={protocolItems(providerEvents)} /> };
export const WorkspaceChanges: Story = {
  render: () => <ThreadStory items={protocolItems(workspaceEvents)} />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Review diff" }));
    await expect(within(canvasElement.ownerDocument.body).getByRole("dialog")).toHaveTextContent("ui/src/App.tsx");
  },
};
export const FileReferences: Story = {
  render: () => <ThreadStory items={protocolItems([fileReferenceEvent])} />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Preview" }));
    await expect(within(canvasElement.ownerDocument.body).getByRole("dialog")).toHaveTextContent("Paperclip Runner Protocol");
  },
};
export const RuntimeRequests: Story = {
  render: () => <RuntimeRequestStory />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Allow once" }));
    await expect(within(canvasElement).getByTestId("task-chat-runtime-request")).toHaveTextContent("resolved");
  },
};
export const RuntimeInput: Story = {
  render: () => <RuntimeInputStory />,
  play: async ({ canvasElement }) => {
    await userEvent.type(within(canvasElement).getByLabelText("Environment"), "production");
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Submit response" }));
    await expect(within(canvasElement).getByTestId("task-chat-runtime-request")).toHaveTextContent("resolved");
  },
};
export const Interactions: Story = { render: () => <InteractionStory /> };
export const ResultsAndTerminalStates: Story = { render: () => <ThreadStory items={protocolItems(resultEvents.slice(1))} /> };
export const DesktopKitchenSink: Story = {
  render: () => <ThreadStory items={[
    { id: "request", kind: "message", author: "human", text: "Implement and verify the Paperclip protocol task-page surfaces.", timestamp: "11:58 AM" },
    ...protocolItems([...providerEvents.slice(0, 4), ...workspaceEvents, fileReferenceEvent, ...resultEvents]),
  ]} disabledReason="Waiting for a runtime decision" />,
};
export const MobileKitchenSink: Story = {
  render: () => <div className="mx-auto max-w-(--sz-390px)"><ThreadStory items={protocolItems([...providerEvents.slice(0, 3), ...workspaceEvents, fileReferenceEvent])} /></div>,
};

// Named regression stories match the Runner Lab qualifications that first
// exposed the production task-page gaps.
export const FrFileReference: Story = { render: () => <ThreadStory items={protocolItems([fileReferenceEvent])} /> };
export const WcWorkspaceChanges: Story = { render: () => <ThreadStory items={protocolItems(workspaceEvents)} /> };
export const PendingQuestions: Story = {
  render: () => <InteractionStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const questionCard = canvas.getByText("Resolve open UX decisions before Phase 1").closest("article");
    if (!questionCard) throw new Error("Question interaction card did not render");
    const questions = within(questionCard);
    await userEvent.click(questions.getByText("Only collapse hidden descendants"));
    await userEvent.click(questions.getByRole("button", { name: "Next" }));
    await userEvent.click(questions.getByText("Inline answer pills"));
    await userEvent.click(questions.getByRole("button", { name: "Send answers" }));
    await waitFor(() => {
      expect(canvas.queryByRole("button", { name: "Send answers" })).not.toBeInTheDocument();
      expect(
        canvas
          .getAllByTestId("interaction-status-badge")
          .some((badge) => badge.textContent?.trim().toLowerCase() === "answered"),
      ).toBe(true);
    });
  },
};
export const CmProviderLabels: Story = { render: () => <ThreadStory items={protocolItems([prp("model.route.changed", { routeId: "cm-route", provider: "claude", requestedModel: "claude", fromModel: null, effectiveModel: "Claude Sonnet", reason: "Managed provider label" }), prp("model.verification.updated", { verificationId: "cm-verify", status: "completed", classes: ["managed"], buffering: false, summary: "Provider-neutral label verified" })])} /> };
