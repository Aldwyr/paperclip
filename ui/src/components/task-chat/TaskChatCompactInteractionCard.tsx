import {
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleHelp,
  GitBranch,
  ListChecks,
  Loader2,
  MessageSquareQuote,
  X,
} from "lucide-react";
import type { IssueDocument } from "@paperclipai/shared";
import type { PaperclipQuestionResponse, PaperclipQuestionSet } from "@paperclipai/adapter-utils";
import { IssueThreadInteractionCard } from "@/components/IssueThreadInteractionCard";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { describeInteractionAudience } from "@/lib/interaction-audience";
import { interactionResolutionErrorMessage } from "@/lib/interaction-resolution-error";
import {
  buildIssueThreadInteractionSummary,
  buildSuggestedTaskTree,
  collectSuggestedTaskClientKeys,
  getCheckboxConfirmationSelectedLabels,
  getItemVerdictProgress,
  normalizeRequestConfirmationTargetHref,
  type AskUserQuestionsAnswer,
  type AskUserQuestionsInteraction,
  type IssueThreadInteraction,
  type RequestCheckboxConfirmationInteraction,
  type RequestConfirmationInteraction,
  type RequestItemVerdictsInteraction,
  type RequestItemVerdictValue,
  type SuggestTasksInteraction,
  type SuggestedTaskTreeNode,
} from "@/lib/issue-thread-interactions";
import { cn } from "@/lib/utils";
import { QuestionForm, QuestionResponseSummary } from "./QuestionForm";
import { TaskChatPlanPreviewCard } from "./TaskChatPlanPreviewCard";

type SharedInteractionProps = Omit<
  ComponentProps<typeof IssueThreadInteractionCard>,
  "interaction" | "primaryActionOnRight"
>;

export interface TaskChatCompactInteractionCardProps extends SharedInteractionProps {
  interaction: IssueThreadInteraction;
  planDocument?: IssueDocument | null;
}

const KIND_COPY = {
  suggest_tasks: { fallbackTitle: "Suggested tasks", label: "Tasks", icon: GitBranch },
  ask_user_questions: { fallbackTitle: "Questions", label: "Questions", icon: CircleHelp },
  request_confirmation: { fallbackTitle: "Confirmation", label: "Confirmation", icon: CheckCircle2 },
  request_checkbox_confirmation: { fallbackTitle: "Choose options", label: "Selection", icon: ListChecks },
  request_item_verdicts: { fallbackTitle: "Review items", label: "Review", icon: MessageSquareQuote },
} as const;

function statusLabel(status: IssueThreadInteraction["status"]): string {
  if (status === "pending") return "Needs response";
  return status.replaceAll("_", " ");
}

function statusTone(status: IssueThreadInteraction["status"]): string {
  if (status === "pending") return "text-(--status-agent-running)";
  if (status === "accepted" || status === "answered") return "text-(--status-task-icon-done)";
  if (status === "rejected" || status === "failed") return "text-destructive";
  return "text-muted-foreground";
}

function StatusIcon({ status }: { status: IssueThreadInteraction["status"] }) {
  if (status === "pending") {
    return <Circle aria-hidden className={cn("h-3.5 w-3.5 fill-current", statusTone(status))} />;
  }
  if (status === "accepted" || status === "answered") {
    return <Check aria-hidden className={cn("h-3.5 w-3.5", statusTone(status))} />;
  }
  if (status === "rejected" || status === "failed") {
    return <X aria-hidden className={cn("h-3.5 w-3.5", statusTone(status))} />;
  }
  return <Circle aria-hidden className={cn("h-3.5 w-3.5", statusTone(status))} />;
}

function InteractionShell({
  interaction,
  audienceLabel,
  children,
}: {
  interaction: IssueThreadInteraction;
  audienceLabel?: string | null;
  children: ReactNode;
}) {
  const kind = KIND_COPY[interaction.kind];
  const Icon = kind.icon;
  return (
    <article className="overflow-hidden rounded-md border border-border bg-card/60">
      <header className="flex min-w-0 items-start gap-2 px-3 py-2.5">
        <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <strong className="min-w-0 truncate text-sm font-medium text-foreground">
              {interaction.title ?? kind.fallbackTitle}
            </strong>
            <span
              className="inline-flex items-center gap-1 text-xs capitalize text-muted-foreground"
              data-testid="interaction-status-badge"
            >
              <StatusIcon status={interaction.status} />
              {statusLabel(interaction.status)}
            </span>
          </div>
          {audienceLabel ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{audienceLabel}</p>
          ) : null}
        </div>
      </header>
      <div className="border-t border-border/70 px-3 py-3">{children}</div>
    </article>
  );
}

function InteractionActionError({ message }: { message: string | null }) {
  return (
    <div aria-live="assertive" data-testid="interaction-action-error">
      {message ? (
        <div className="mt-2 rounded-sm border border-destructive/60 bg-destructive/10 px-2.5 py-2 text-sm text-destructive">
          {message}
        </div>
      ) : null}
    </div>
  );
}

function Details({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <details className="mt-2">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground">
        <ChevronDown aria-hidden className="h-3.5 w-3.5" /> Details
      </summary>
      <div className="mt-2 rounded-sm bg-muted/40 px-2.5 py-2 text-sm text-muted-foreground">
        {children}
      </div>
    </details>
  );
}

function ActionRow({ children, hint }: { children: ReactNode; hint?: string | null }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
      {hint ? <span className="mr-auto text-xs text-muted-foreground">{hint}</span> : <span className="mr-auto" />}
      {children}
    </div>
  );
}

function targetLabel(interaction: RequestConfirmationInteraction | RequestCheckboxConfirmationInteraction | RequestItemVerdictsInteraction) {
  const target = interaction.payload.target;
  if (!target) return null;
  const label = target.label ?? (target.type === "issue_document" ? target.key : target.key);
  const revision = target.revisionNumber == null ? null : `v${target.revisionNumber}`;
  return [label, revision].filter(Boolean).join(" · ");
}

function CompactTarget({ interaction }: { interaction: RequestConfirmationInteraction | RequestCheckboxConfirmationInteraction | RequestItemVerdictsInteraction }) {
  const target = interaction.payload.target;
  const label = targetLabel(interaction);
  if (!target || !label) return null;
  const href = target.href ? normalizeRequestConfirmationTargetHref(target.href) : null;
  if (href) {
    return <a href={href} className="inline-flex rounded-sm border border-border px-2 py-0.5 font-mono text-xs text-foreground hover:bg-muted/60">{label}</a>;
  }
  return <span className="inline-flex rounded-sm border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground">{label}</span>;
}

function PlanReviewPreview({
  interaction,
  planDocument,
}: {
  interaction: RequestConfirmationInteraction;
  planDocument?: IssueDocument | null;
}) {
  const target = interaction.payload.target;
  if (target?.type !== "issue_document" || target.key !== "plan") return null;

  const targetRevision = target.revisionNumber ?? null;
  const documentMatchesTarget = Boolean(
    planDocument
    && (targetRevision == null || planDocument.latestRevisionNumber === targetRevision),
  );

  return (
    <TaskChatPlanPreviewCard
      source={{
        kind: "saved",
        document: documentMatchesTarget ? planDocument : null,
        revision: targetRevision,
        fallbackTitle: target.label,
      }}
      href="#document-plan"
      testId="plan-review-preview"
      ariaLabel={`Open ${target.label ?? (targetRevision == null ? "plan" : `plan revision ${targetRevision}`)}`}
    />
  );
}

function ResolvedInteraction({ interaction }: { interaction: IssueThreadInteraction }) {
  const summary = buildIssueThreadInteractionSummary(interaction);
  let detail: ReactNode = null;

  if (interaction.kind === "ask_user_questions" && interaction.result?.answers) {
    const questionSet = questionSetForInteraction(interaction);
    const response = questionResponseForInteraction(interaction, questionSet);
    detail = response ? <div className="mt-2"><QuestionResponseSummary questionSet={questionSet} response={response} /></div> : null;
  } else if (interaction.kind === "request_checkbox_confirmation") {
    const labels = getCheckboxConfirmationSelectedLabels({ payload: interaction.payload, result: interaction.result });
    detail = labels.length > 0 ? <p className="mt-1 text-xs text-muted-foreground">{labels.join(", ")}</p> : null;
  } else if (interaction.kind === "request_item_verdicts") {
    const progress = getItemVerdictProgress({ payload: interaction.payload, result: interaction.result });
    detail = progress.decided > 0 ? (
      <p className="mt-1 text-xs text-muted-foreground">
        {progress.approved} approved · {progress.rejected} rejected{progress.deferred > 0 ? ` · ${progress.deferred} deferred` : ""}
      </p>
    ) : null;
  } else if (interaction.kind === "request_confirmation" && interaction.result?.reason) {
    detail = <p className="mt-1 text-xs text-muted-foreground">{interaction.result.reason}</p>;
  } else if (interaction.kind === "suggest_tasks" && interaction.result?.rejectionReason) {
    detail = <p className="mt-1 text-xs text-muted-foreground">{interaction.result.rejectionReason}</p>;
  }

  return (
    <div className="flex items-start gap-2">
      <StatusIcon status={interaction.status} />
      <div className="min-w-0">
        <p className="text-sm text-foreground">{summary}</p>
        {detail}
      </div>
    </div>
  );
}

function questionSetForInteraction(interaction: AskUserQuestionsInteraction): PaperclipQuestionSet {
  if (interaction.payload.questionSet) return interaction.payload.questionSet;
  return {
    schema: "paperclip.question_set.v1",
    ...(interaction.title ? { title: interaction.title } : {}),
    ...(interaction.payload.submitLabel ? { submitLabel: interaction.payload.submitLabel } : {}),
    questions: interaction.payload.questions.map((question) => {
      const freeText = question.options.find((option) => option.freeText === true);
      return {
        id: question.id,
        prompt: question.prompt,
        ...(question.helpText ? { helpText: question.helpText } : {}),
        required: question.required === true,
        answerMode: question.selectionMode === "multi" ? "multi_select" as const : "single_select" as const,
        options: question.options.filter((option) => option.freeText !== true).map((option) => ({
          id: option.id,
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        })),
        ...(freeText ? { customAnswer: { enabled: true as const, label: freeText.label, ...(freeText.description ? { placeholder: freeText.description } : {}) } } : {}),
      };
    }),
  };
}

function questionResponseForInteraction(
  interaction: AskUserQuestionsInteraction,
  questionSet: PaperclipQuestionSet,
): PaperclipQuestionResponse | null {
  if (!interaction.result?.answers) return null;
  return {
    schema: "paperclip.question_response.v1",
    answers: Object.fromEntries(interaction.result.answers.map((answer) => {
      const question = questionSet.questions.find((candidate) => candidate.id === answer.questionId);
      return [answer.questionId, question?.answerMode === "text"
        ? { ...(answer.otherText ? { text: answer.otherText } : {}) }
        : {
            selectedOptionIds: answer.optionIds,
            ...(answer.otherText ? { customText: answer.otherText } : {}),
          }];
    })),
  };
}

function AskUserQuestionsCard({
  interaction,
  onSubmitInteractionAnswers,
  onCancelInteraction,
  errorMessage,
}: {
  interaction: AskUserQuestionsInteraction;
  onSubmitInteractionAnswers?: SharedInteractionProps["onSubmitInteractionAnswers"];
  onCancelInteraction?: SharedInteractionProps["onCancelInteraction"];
  errorMessage: (error: unknown) => string;
}) {
  const questionSet = questionSetForInteraction(interaction);
  const initialResponse = questionResponseForInteraction(interaction, questionSet);
  return (
    <QuestionForm
      id={interaction.id}
      questionSet={questionSet}
      initialResponse={initialResponse}
      implicitCustomAnswer={interaction.payload.questionSet === undefined}
      disabled={!onSubmitInteractionAnswers}
      onSubmit={async (response) => {
        const answers: AskUserQuestionsAnswer[] = questionSet.questions.map((question) => {
          const answer = response.answers[question.id];
          const otherText = question.answerMode === "text" ? answer?.text?.trim() : answer?.customText?.trim();
          return {
            questionId: question.id,
            optionIds: question.answerMode === "text" ? [] : answer?.selectedOptionIds ?? [],
            ...(otherText ? { otherText } : {}),
          };
        });
        try {
          await onSubmitInteractionAnswers?.(interaction, answers);
        } catch (error) {
          throw new Error(errorMessage(error));
        }
      }}
      onCancel={onCancelInteraction ? async () => {
        try {
          await onCancelInteraction(interaction);
        } catch (error) {
          throw new Error(errorMessage(error));
        }
      } : undefined}
    />
  );
}

function ConfirmationCard({
  interaction,
  planDocument,
  onAcceptInteraction,
  onRejectInteraction,
  externalReferences,
  errorMessage,
}: {
  interaction: RequestConfirmationInteraction;
  planDocument?: IssueDocument | null;
  onAcceptInteraction?: SharedInteractionProps["onAcceptInteraction"];
  onRejectInteraction?: SharedInteractionProps["onRejectInteraction"];
  externalReferences?: SharedInteractionProps["externalReferences"];
  errorMessage: (error: unknown) => string;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [working, setWorking] = useState<"accept" | "reject" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const collectsRejectReason = Boolean(
    interaction.payload.rejectRequiresReason
    || interaction.payload.allowDeclineReason
    || interaction.payload.declineReasonPlaceholder,
  );
  const isPlanConfirmation = interaction.payload.target?.type === "issue_document"
    && interaction.payload.target.key === "plan";

  async function resolve(action: "accept" | "reject") {
    if (action === "reject" && interaction.payload.rejectRequiresReason && !reason.trim()) return;
    setWorking(action);
    setActionError(null);
    try {
      if (action === "accept") await onAcceptInteraction?.(interaction);
      else await onRejectInteraction?.(interaction, reason.trim() || undefined);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  return (
    <div>
      {isPlanConfirmation ? (
        <PlanReviewPreview interaction={interaction} planDocument={planDocument} />
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="min-w-0 flex-1 text-sm leading-5 text-foreground">{interaction.payload.prompt}</p>
          <CompactTarget interaction={interaction} />
        </div>
      )}
      {!isPlanConfirmation && interaction.payload.detailsMarkdown ? (
        <Details><MarkdownBody externalReferences={externalReferences}>{interaction.payload.detailsMarkdown}</MarkdownBody></Details>
      ) : null}
      {rejecting ? (
        <div className="mt-3 space-y-1.5">
          <label htmlFor={`${interaction.id}-reject-reason`} className="text-xs font-medium text-foreground">
            {interaction.payload.rejectReasonLabel ?? "What should change?"}{interaction.payload.rejectRequiresReason ? "" : " (optional)"}
          </label>
          <Textarea
            id={`${interaction.id}-reject-reason`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={interaction.payload.declineReasonPlaceholder ?? "Add a short note"}
            className="min-h-16 resize-y bg-background text-sm"
            autoFocus
          />
        </div>
      ) : null}
      <InteractionActionError message={actionError} />
      <ActionRow>
        {rejecting ? (
          <>
            <Button type="button" size="sm" variant="ghost" disabled={working !== null} onClick={() => setRejecting(false)}>Back</Button>
            <Button type="button" size="sm" variant="outline" disabled={working !== null || (Boolean(interaction.payload.rejectRequiresReason) && !reason.trim()) || !onRejectInteraction} onClick={() => void resolve("reject")}>
              {working === "reject" ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
              {interaction.payload.rejectLabel ?? "Reject"}
            </Button>
          </>
        ) : (
          <>
            <Button type="button" size="sm" variant="ghost" disabled={working !== null || !onRejectInteraction} onClick={() => collectsRejectReason ? setRejecting(true) : void resolve("reject")}>
              {interaction.payload.rejectLabel ?? "Reject"}
            </Button>
            <Button type="button" size="sm" disabled={working !== null || !onAcceptInteraction} onClick={() => void resolve("accept")}>
              {working === "accept" ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
              {interaction.payload.acceptLabel ?? "Approve"}
            </Button>
          </>
        )}
      </ActionRow>
    </div>
  );
}

function CheckboxConfirmationCard({
  interaction,
  onAcceptInteraction,
  onRejectInteraction,
  externalReferences,
  errorMessage,
}: {
  interaction: RequestCheckboxConfirmationInteraction;
  onAcceptInteraction?: SharedInteractionProps["onAcceptInteraction"];
  onRejectInteraction?: SharedInteractionProps["onRejectInteraction"];
  externalReferences?: SharedInteractionProps["externalReferences"];
  errorMessage: (error: unknown) => string;
}) {
  const [selected, setSelected] = useState(() => new Set(interaction.payload.defaultSelectedOptionIds ?? []));
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [working, setWorking] = useState<"accept" | "reject" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const collectsRejectReason = Boolean(
    interaction.payload.rejectRequiresReason
    || interaction.payload.allowDeclineReason
    || interaction.payload.declineReasonPlaceholder,
  );
  const minimum = interaction.payload.minSelected ?? 0;
  const maximum = interaction.payload.maxSelected ?? Number.POSITIVE_INFINITY;
  const validCount = selected.size >= minimum && selected.size <= maximum;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < maximum) next.add(id);
      return next;
    });
  }

  async function resolve(action: "accept" | "reject") {
    if (action === "accept" && !validCount) return;
    if (action === "reject" && interaction.payload.rejectRequiresReason && !reason.trim()) return;
    setWorking(action);
    setActionError(null);
    try {
      if (action === "accept") await onAcceptInteraction?.(interaction, undefined, [...selected]);
      else await onRejectInteraction?.(interaction, reason.trim() || undefined);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  const countHint = maximum < Number.POSITIVE_INFINITY
    ? `${selected.size} selected · choose ${minimum}–${maximum}`
    : minimum > 0 ? `${selected.size} selected · at least ${minimum}` : `${selected.size} selected`;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-sm leading-5 text-foreground">{interaction.payload.prompt}</p>
        <CompactTarget interaction={interaction} />
      </div>
      <div className="mt-3 grid gap-1" role="group" aria-label={interaction.payload.prompt}>
        {interaction.payload.options.map((option) => (
          <label key={option.id} className="flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 hover:bg-muted/50">
            <Checkbox checked={selected.has(option.id)} onCheckedChange={() => toggle(option.id)} className="mt-0.5" />
            <span className="min-w-0">
              <span className="block text-sm leading-5 text-foreground">{option.label}</span>
              {option.description ? <span className="block text-xs leading-4 text-muted-foreground">{option.description}</span> : null}
            </span>
          </label>
        ))}
      </div>
      {interaction.payload.detailsMarkdown ? (
        <Details><MarkdownBody externalReferences={externalReferences}>{interaction.payload.detailsMarkdown}</MarkdownBody></Details>
      ) : null}
      {rejecting ? (
        <div className="mt-3 space-y-1.5">
          <label htmlFor={`${interaction.id}-reject-reason`} className="text-xs font-medium text-foreground">
            {interaction.payload.rejectReasonLabel ?? "What should change?"}{interaction.payload.rejectRequiresReason ? "" : " (optional)"}
          </label>
          <Textarea id={`${interaction.id}-reject-reason`} value={reason} onChange={(event) => setReason(event.target.value)} placeholder={interaction.payload.declineReasonPlaceholder ?? "Add a short note"} className="min-h-16 resize-y bg-background text-sm" autoFocus />
        </div>
      ) : null}
      <InteractionActionError message={actionError} />
      <ActionRow hint={countHint}>
        {rejecting ? (
          <>
            <Button type="button" size="sm" variant="ghost" disabled={working !== null} onClick={() => setRejecting(false)}>Back</Button>
            <Button type="button" size="sm" variant="outline" disabled={working !== null || (Boolean(interaction.payload.rejectRequiresReason) && !reason.trim()) || !onRejectInteraction} onClick={() => void resolve("reject")}>
              {working === "reject" ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}{interaction.payload.rejectLabel ?? "Decline"}
            </Button>
          </>
        ) : (
          <>
            <Button type="button" size="sm" variant="ghost" disabled={working !== null || !onRejectInteraction} onClick={() => collectsRejectReason ? setRejecting(true) : void resolve("reject")}>{interaction.payload.rejectLabel ?? "Decline"}</Button>
            <Button type="button" size="sm" disabled={working !== null || !validCount || !onAcceptInteraction} onClick={() => void resolve("accept")}>
              {working === "accept" ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}{interaction.payload.acceptLabel ?? "Confirm selection"}
            </Button>
          </>
        )}
      </ActionRow>
    </div>
  );
}

function SuggestedTaskRow({
  node,
  depth,
  selected,
  onToggle,
}: {
  node: SuggestedTaskTreeNode;
  depth: number;
  selected: Set<string>;
  onToggle: (node: SuggestedTaskTreeNode) => void;
}) {
  if (node.task.hiddenInPreview) return null;
  const hiddenCount = collectSuggestedTaskClientKeys(node).filter((key) => key !== node.task.clientKey && node.children.some((child) => child.task.clientKey === key && child.task.hiddenInPreview)).length;
  return (
    <li>
      <label className="flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 hover:bg-muted/50" style={{ paddingLeft: `${depth * 16 + 8}px` }}>
        <Checkbox checked={selected.has(node.task.clientKey)} onCheckedChange={() => onToggle(node)} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm leading-5 text-foreground">{node.task.title}</span>
          {hiddenCount > 0 ? <span className="block text-xs text-muted-foreground">+ {hiddenCount} hidden follow-up</span> : null}
        </span>
      </label>
      {node.children.length > 0 ? (
        <ul>{node.children.map((child) => <SuggestedTaskRow key={child.task.clientKey} node={child} depth={depth + 1} selected={selected} onToggle={onToggle} />)}</ul>
      ) : null}
    </li>
  );
}

function SuggestedTasksCard({
  interaction,
  onAcceptInteraction,
  onRejectInteraction,
  errorMessage,
}: {
  interaction: SuggestTasksInteraction;
  onAcceptInteraction?: SharedInteractionProps["onAcceptInteraction"];
  onRejectInteraction?: SharedInteractionProps["onRejectInteraction"];
  errorMessage: (error: unknown) => string;
}) {
  const roots = useMemo(() => buildSuggestedTaskTree(interaction.payload.tasks), [interaction.payload.tasks]);
  const taskByKey = useMemo(() => new Map(interaction.payload.tasks.map((task) => [task.clientKey, task])), [interaction.payload.tasks]);
  const [selected, setSelected] = useState(() => new Set(interaction.payload.tasks.map((task) => task.clientKey)));
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [working, setWorking] = useState<"accept" | "reject" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function toggle(node: SuggestedTaskTreeNode) {
    setSelected((current) => {
      const next = new Set(current);
      const subtree = collectSuggestedTaskClientKeys(node);
      if (next.has(node.task.clientKey)) subtree.forEach((key) => next.delete(key));
      else {
        subtree.forEach((key) => next.add(key));
        let parentKey = node.task.parentClientKey;
        while (parentKey) {
          next.add(parentKey);
          parentKey = taskByKey.get(parentKey)?.parentClientKey;
        }
      }
      return next;
    });
  }

  async function resolve(action: "accept" | "reject") {
    setWorking(action);
    setActionError(null);
    try {
      if (action === "accept") await onAcceptInteraction?.(interaction, [...selected]);
      else await onRejectInteraction?.(interaction, reason.trim() || undefined);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  return (
    <div>
      <p className="text-sm leading-5 text-foreground">Select the tasks to create.</p>
      <ul className="mt-2" aria-label="Suggested tasks">{roots.map((node) => <SuggestedTaskRow key={node.task.clientKey} node={node} depth={0} selected={selected} onToggle={toggle} />)}</ul>
      {rejecting ? (
        <div className="mt-3 space-y-1.5">
          <label htmlFor={`${interaction.id}-reject-reason`} className="text-xs font-medium text-foreground">Why should these tasks change? (optional)</label>
          <Textarea id={`${interaction.id}-reject-reason`} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Add a short note" className="min-h-16 resize-y bg-background text-sm" autoFocus />
        </div>
      ) : null}
      <InteractionActionError message={actionError} />
      <ActionRow hint={`${selected.size} of ${interaction.payload.tasks.length} selected`}>
        {rejecting ? (
          <>
            <Button type="button" size="sm" variant="ghost" disabled={working !== null} onClick={() => setRejecting(false)}>Back</Button>
            <Button type="button" size="sm" variant="outline" disabled={working !== null || !onRejectInteraction} onClick={() => void resolve("reject")}>
              {working === "reject" ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}Send back
            </Button>
          </>
        ) : (
          <>
            <Button type="button" size="sm" variant="ghost" disabled={working !== null || !onRejectInteraction} onClick={() => setRejecting(true)}>Revise</Button>
            <Button type="button" size="sm" disabled={working !== null || selected.size === 0 || !onAcceptInteraction} onClick={() => void resolve("accept")}>
              {working === "accept" ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}Create selected
            </Button>
          </>
        )}
      </ActionRow>
    </div>
  );
}

type VerdictDraft = { verdict: RequestItemVerdictValue; reason: string };

function ItemVerdictsCard({
  interaction,
  onSubmitInteractionVerdicts,
  externalReferences,
  errorMessage,
}: {
  interaction: RequestItemVerdictsInteraction;
  onSubmitInteractionVerdicts?: SharedInteractionProps["onSubmitInteractionVerdicts"];
  externalReferences?: SharedInteractionProps["externalReferences"];
  errorMessage: (error: unknown) => string;
}) {
  const items = interaction.payload.items;
  const resolvedById = useMemo(() => new Map((interaction.result?.items ?? []).map((item) => [item.id, item])), [interaction.result]);
  const firstPendingIndex = Math.max(items.findIndex((item) => !resolvedById.has(item.id)), 0);
  const [page, setPage] = useState(firstPendingIndex);
  const [drafts, setDrafts] = useState<Map<string, VerdictDraft>>(new Map());
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const enabledVerdicts = interaction.payload.verdicts ?? ["approve", "reject"];
  const requireReasonOn = new Set(interaction.payload.requireReasonOn ?? ["reject"]);

  useEffect(() => setPage((current) => Math.min(current, Math.max(items.length - 1, 0))), [items.length]);
  useEffect(() => {
    setDrafts((current) => {
      const next = new Map(current);
      let changed = false;
      for (const id of resolvedById.keys()) {
        if (next.delete(id)) changed = true;
      }
      return changed ? next : current;
    });
    const nextPending = items.findIndex((candidate) => !resolvedById.has(candidate.id));
    if (nextPending >= 0) setPage(nextPending);
  }, [items, resolvedById]);
  const item = items[page];
  if (!item) return <p className="text-sm text-muted-foreground">No review items were provided.</p>;
  const resolved = resolvedById.get(item.id);
  const draft = drafts.get(item.id);
  const itemHref = item.href ? normalizeRequestConfirmationTargetHref(item.href) : null;
  const pageComplete = Boolean(resolved || (draft && (!requireReasonOn.has(draft.verdict) || draft.reason.trim())));

  function setVerdict(verdict: RequestItemVerdictValue) {
    setDrafts((current) => {
      const next = new Map(current);
      const existing = next.get(item.id);
      next.set(item.id, { verdict, reason: existing?.reason ?? "" });
      return next;
    });
  }

  function setReason(reason: string) {
    setDrafts((current) => {
      const next = new Map(current);
      const existing = next.get(item.id);
      if (existing) next.set(item.id, { ...existing, reason });
      return next;
    });
  }

  async function submit() {
    if (!onSubmitInteractionVerdicts) return;
    const verdicts = [...drafts].map(([id, value]) => ({ id, verdict: value.verdict, ...(value.reason.trim() ? { reason: value.reason.trim() } : {}) }));
    if (verdicts.length === 0 || verdicts.some((entry) => requireReasonOn.has(entry.verdict) && !entry.reason)) return;
    setWorking(true);
    setActionError(null);
    try {
      await onSubmitInteractionVerdicts(interaction, verdicts);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setWorking(false);
    }
  }

  const allDraftsValid = drafts.size > 0 && [...drafts.values()].every(
    (candidate) => !requireReasonOn.has(candidate.verdict) || candidate.reason.trim(),
  );

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>Item {page + 1} of {items.length}</span>
        <span>{drafts.size + resolvedById.size} decided</span>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-5 text-foreground">{item.label}</p>
          {item.description ? <p className="text-xs leading-4 text-muted-foreground">{item.description}</p> : null}
        </div>
        {itemHref ? <a href={itemHref} className="text-xs font-medium text-primary hover:underline">Open</a> : null}
      </div>
      {item.previewMarkdown ? (
        <div className="mt-2 rounded-sm bg-muted/40 px-2.5 py-2 text-xs"><MarkdownBody externalReferences={externalReferences}>{item.previewMarkdown}</MarkdownBody></div>
      ) : null}
      {resolved ? (
        <p className="mt-3 inline-flex rounded-sm border border-border px-2 py-1 text-xs capitalize text-muted-foreground">{resolved.verdict}{resolved.reason ? ` · ${resolved.reason}` : ""}</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label={`Verdict for ${item.label}`}>
          {enabledVerdicts.map((verdict) => (
            <Button key={verdict} type="button" size="sm" variant={draft?.verdict === verdict ? "secondary" : "outline"} aria-pressed={draft?.verdict === verdict} onClick={() => setVerdict(verdict)} className="capitalize">
              {verdict}
            </Button>
          ))}
        </div>
      )}
      {!resolved && draft && requireReasonOn.has(draft.verdict) ? (
        <div className="mt-2 space-y-1.5">
          <label htmlFor={`${interaction.id}-${item.id}-reason`} className="text-xs font-medium text-foreground">{interaction.payload.reasonLabel ?? "Reason"}</label>
          <Textarea id={`${interaction.id}-${item.id}-reason`} value={draft.reason} onChange={(event) => setReason(event.target.value)} placeholder="Add a short reason" className="min-h-16 resize-y bg-background text-sm" autoFocus />
        </div>
      ) : null}
      {interaction.payload.detailsMarkdown ? <Details><MarkdownBody externalReferences={externalReferences}>{interaction.payload.detailsMarkdown}</MarkdownBody></Details> : null}
      <InteractionActionError message={actionError} />
      <ActionRow hint={`${page + 1} / ${items.length}`}>
        {page > 0 ? <Button type="button" size="sm" variant="outline" disabled={working} onClick={() => setPage((current) => current - 1)}><ChevronLeft aria-hidden className="h-4 w-4" /> Back</Button> : null}
        {page < items.length - 1 ? (
          <>
            {drafts.size > 0 ? <Button type="button" size="sm" variant="outline" disabled={!allDraftsValid || working || !onSubmitInteractionVerdicts} onClick={() => void submit()}>Apply {drafts.size}</Button> : null}
            <Button type="button" size="sm" disabled={!pageComplete || working} onClick={() => setPage((current) => current + 1)}>Next <ChevronRight aria-hidden className="h-4 w-4" /></Button>
          </>
        ) : (
          <Button type="button" size="sm" disabled={!allDraftsValid || working || !onSubmitInteractionVerdicts} onClick={() => void submit()}>
            {working ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}Apply decisions
          </Button>
        )}
      </ActionRow>
    </div>
  );
}

export function TaskChatCompactInteractionCard({
  interaction,
  planDocument,
  agentMap,
  currentUserId,
  userLabelMap,
  onAcceptInteraction,
  onRejectInteraction,
  onSubmitInteractionAnswers,
  onCancelInteraction,
  onSubmitInteractionVerdicts,
  externalReferences,
}: TaskChatCompactInteractionCardProps) {
  const creatorLabel = interaction.createdByAgentId
    ? agentMap?.get(interaction.createdByAgentId)?.name
    : interaction.createdByUserId
      ? interaction.createdByUserId === currentUserId ? "You" : userLabelMap?.get(interaction.createdByUserId)
      : null;
  const addresseeLabel = interaction.addresseeAgentId
    ? agentMap?.get(interaction.addresseeAgentId)?.name
    : interaction.addresseeUserId
      ? interaction.addresseeUserId === currentUserId
        ? "You"
        : userLabelMap?.get(interaction.addresseeUserId) ?? interaction.addresseeUserId
      : null;
  const audience = describeInteractionAudience({ interaction, creatorLabel, addresseeLabel });
  const errorMessage = (error: unknown) => interactionResolutionErrorMessage(error, audience);
  const audienceLabel = interaction.status === "pending" && !audience.isOpen ? audience.shortSummary : null;

  return (
    <InteractionShell interaction={interaction} audienceLabel={audienceLabel}>
      {interaction.status !== "pending" ? (
        <ResolvedInteraction interaction={interaction} />
      ) : interaction.kind === "ask_user_questions" ? (
        <AskUserQuestionsCard interaction={interaction} onSubmitInteractionAnswers={onSubmitInteractionAnswers} onCancelInteraction={onCancelInteraction} errorMessage={errorMessage} />
      ) : interaction.kind === "request_confirmation" ? (
        <ConfirmationCard interaction={interaction} planDocument={planDocument} onAcceptInteraction={onAcceptInteraction} onRejectInteraction={onRejectInteraction} externalReferences={externalReferences} errorMessage={errorMessage} />
      ) : interaction.kind === "request_checkbox_confirmation" ? (
        <CheckboxConfirmationCard interaction={interaction} onAcceptInteraction={onAcceptInteraction} onRejectInteraction={onRejectInteraction} externalReferences={externalReferences} errorMessage={errorMessage} />
      ) : interaction.kind === "suggest_tasks" ? (
        <SuggestedTasksCard interaction={interaction} onAcceptInteraction={onAcceptInteraction} onRejectInteraction={onRejectInteraction} errorMessage={errorMessage} />
      ) : (
        <ItemVerdictsCard interaction={interaction} onSubmitInteractionVerdicts={onSubmitInteractionVerdicts} externalReferences={externalReferences} errorMessage={errorMessage} />
      )}
    </InteractionShell>
  );
}
