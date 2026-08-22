// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueDocument } from "@paperclipai/shared";
import type { IssueThreadInteraction, RequestConfirmationInteraction } from "@/lib/issue-thread-interactions";
import { ThemeProvider } from "@/context/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  expiredSecretProposalInteraction,
  pendingAskUserQuestionsInteraction,
  pendingRequestItemVerdictsInteraction,
} from "@/fixtures/issueThreadInteractionFixtures";
import { TaskChatInteractionCard } from "./TaskChatInteractionCard";
import { TaskChatThreadView } from "./TaskChatThreadView";
import type { TaskChatInteractionItem } from "./task-chat-model";

function createRequestConfirmation(
  overrides: Partial<RequestConfirmationInteraction> = {},
): RequestConfirmationInteraction {
  return {
    id: "confirmation-1",
    companyId: "company-1",
    issueId: "issue-1",
    kind: "request_confirmation",
    title: "Approve the plan",
    summary: "Review and approve the latest plan.",
    status: "pending",
    continuationPolicy: "wake_assignee",
    resolverPolicy: "anyone",
    requestedResolverPolicy: "anyone",
    effectiveResolverPolicy: "anyone",
    resolverPolicyProvenance: "inherited",
    effectiveResolverPolicySource: "requested",
    legacyResolverPolicyAliases: { requested: "board_or_agents", effective: "board_or_agents" },
    createdByAgentId: "agent-1",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    createdAt: new Date("2026-04-06T12:01:00.000Z"),
    updatedAt: new Date("2026-04-06T12:01:00.000Z"),
    resolvedAt: null,
    payload: {
      version: 1,
      prompt: "Approve the plan?",
    },
    result: null,
    ...overrides,
  };
}

function interactionItem(
  interaction: IssueThreadInteraction,
): TaskChatInteractionItem {
  return { id: `interaction:${interaction.id}`, kind: "interaction", interaction };
}

describe("TaskChatInteractionCard", () => {
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

  it("renders a pending confirmation as a full interaction card", () => {
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
          <TaskChatInteractionCard item={interactionItem(createRequestConfirmation())} />
        </ThemeProvider>
        </TooltipProvider>,
      );
    });
    const card = container.querySelector('[data-testid="task-chat-interaction"]');
    expect(card).not.toBeNull();
    expect(card?.id).toBe("interaction-confirmation-1");
    expect(container.textContent).toContain("Approve the plan");
  });

  it("renders a plan confirmation as a linked document preview", () => {
    const interaction = createRequestConfirmation({
      title: "Review plan revision 3",
      payload: {
        version: 1,
        prompt: "Approve plan revision 3?",
        acceptLabel: "Approve plan",
        target: {
          type: "issue_document",
          issueId: "issue-1",
          documentId: "document-plan",
          key: "plan",
          revisionId: "revision-3",
          revisionNumber: 3,
          label: "Plan v3",
        },
      },
    });
    const planDocument = {
      id: "document-plan",
      issueId: "issue-1",
      key: "plan",
      title: "Plan",
      body: "# Health-check endpoint\n1. Define the health response contract.\n2. Test readiness before and after startup.\n3. Document the verification request.",
      latestRevisionId: "revision-3",
      latestRevisionNumber: 3,
    } as IssueDocument;

    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
            <TaskChatInteractionCard
              item={interactionItem(interaction)}
              planDocument={planDocument}
            />
          </ThemeProvider>
        </TooltipProvider>,
      );
    });

    const preview = container.querySelector('[data-testid="plan-review-preview"]');
    expect(preview?.getAttribute("href")).toBe("#document-plan");
    expect(preview?.getAttribute("aria-label")).toBe("Open Plan v3");
    expect(container.textContent).toContain("Health-check endpoint");
    expect(container.textContent).toContain("Test readiness before and after startup.");
    expect(container.textContent).not.toContain("Approve plan revision 3?");
    expect(container.textContent).toContain("Approve plan");
  });

  it("puts the primary CTA at the right edge of the compact action row", () => {
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
          <TaskChatInteractionCard item={interactionItem(createRequestConfirmation())} />
        </ThemeProvider>
        </TooltipProvider>,
      );
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const approve = buttons.find((button) => button.textContent === "Approve");
    const reject = buttons.find((button) => button.textContent === "Reject");
    expect(approve).not.toBeUndefined();
    expect(reject).not.toBeUndefined();
    const row = approve?.parentElement;
    expect(row).toBe(reject?.parentElement);
    expect(Array.from(row?.querySelectorAll("button") ?? []).at(-1)).toBe(approve);
    expect(container.textContent).not.toContain("proposed by");
    expect(container.textContent).not.toContain("Review and approve the latest plan.");
  });

  it("shows one question at a time and preserves answers across pages", async () => {
    const submit = vi.fn();
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
            <TaskChatInteractionCard
              item={interactionItem(pendingAskUserQuestionsInteraction)}
              onSubmitInteractionAnswers={submit}
            />
          </ThemeProvider>
        </TooltipProvider>,
      );
    });

    expect(container.textContent).toContain("Question 1 of 2");
    expect(container.textContent).toContain("How aggressive should");
    expect(container.textContent).not.toContain("What should the answered-state card emphasize");

    const firstAnswer = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Only collapse hidden descendants"));
    await act(async () => firstAnswer?.click());
    const next = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Next");
    await act(async () => next?.click());

    expect(container.textContent).toContain("Question 2 of 2");
    expect(container.textContent).toContain("What should the answered-state card emphasize");
    expect(container.textContent).not.toContain("How aggressive should");

    const secondAnswer = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Inline answer pills"));
    await act(async () => secondAnswer?.click());
    const send = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Send answers");
    await act(async () => send?.click());

    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]?.[1]).toEqual([
      { questionId: "collapse-depth", optionIds: ["visible-root"] },
      { questionId: "post-submit-summary", optionIds: ["answers-inline"] },
    ]);
  });

  it("paginates item verdicts instead of expanding the whole review set", async () => {
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
            <TaskChatInteractionCard
              item={interactionItem(pendingRequestItemVerdictsInteraction)}
              onSubmitInteractionVerdicts={() => undefined}
            />
          </ThemeProvider>
        </TooltipProvider>,
      );
    });

    expect(container.textContent).toContain("Item 1 of 5");
    expect(container.textContent).toContain("Spring launch recap");
    expect(container.textContent).not.toContain("Monthly changelog digest");

    const approve = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "approve");
    await act(async () => approve?.click());
    const next = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Next");
    await act(async () => next?.click());

    expect(container.textContent).toContain("Item 2 of 5");
    expect(container.textContent).toContain("Monthly changelog digest");
    expect(container.textContent).not.toContain("Spring launch recap");
  });

  it("demotes an expired confirmation to a marker row", () => {
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
          <TaskChatInteractionCard
            item={interactionItem(createRequestConfirmation({ status: "expired" }))}
          />
        </ThemeProvider>
        </TooltipProvider>,
      );
    });
    expect(container.querySelector('[data-testid="task-chat-interaction"]')).toBeNull();
    expect(container.textContent).toContain("Approve the plan");
    expect(container.textContent).toContain("expired");
  });

  it("renders an expired secret proposal as a full receipt", () => {
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
            <TaskChatInteractionCard item={interactionItem(expiredSecretProposalInteraction)} />
          </ThemeProvider>
        </TooltipProvider>,
      );
    });

    expect(container.querySelector('[data-testid="task-chat-interaction"]')).not.toBeNull();
    expect(container.textContent).toContain("Secret binding requested");
    expect(container.textContent).toContain("OpenAI API key");
    expect(container.textContent).toContain("access.evals_openai_api_key");
    expect(container.textContent).toContain("EvalsEngineer");
    expect(container.textContent).toContain("A fresh proposal is required");
  });
});

describe("TaskChatThreadView interaction items", () => {
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

  it("renders interaction items through renderInteraction", () => {
    const item = interactionItem(createRequestConfirmation());
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
          <TaskChatThreadView
            items={[item]}
            scroll={false}
            renderInteraction={(it) => <TaskChatInteractionCard item={it} />}
          />
        </ThemeProvider>
        </TooltipProvider>,
      );
    });
    expect(container.querySelector('[data-testid="task-chat-interaction"]')).not.toBeNull();
  });

  it("renders nothing for interaction items without renderInteraction", () => {
    const item = interactionItem(createRequestConfirmation());
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
          <TaskChatThreadView items={[item]} scroll={false} />
        </ThemeProvider>
        </TooltipProvider>,
      );
    });
    expect(container.querySelector('[data-testid="task-chat-interaction"]')).toBeNull();
  });
});
