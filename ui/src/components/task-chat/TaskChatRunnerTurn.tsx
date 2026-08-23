import { useId, useRef, useState, type ComponentType, type SVGProps } from "react";
import type { IssueDocument } from "@paperclipai/shared";
import { Brain, Check, ChevronRight, OctagonX, X } from "lucide-react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { useSecondTick } from "@/hooks/useSecondTick";
import { cn } from "@/lib/utils";
import type {
  TaskChatItem,
  TaskChatMessageItem,
  TaskChatMarkerItem,
  TaskChatProtocolItem,
  TaskChatProviderActivityItem,
  TaskChatRuntimeRequestDecision,
  TaskChatRuntimeRequestItem,
  TaskChatThinkingItem,
  TaskChatToolItem,
} from "./task-chat-model";
import { TaskChatAgentIdentity } from "./TaskChatBubble";
import { TaskChatProtocolActivityRow } from "./TaskChatProtocolActivityRow";
import { TaskChatProtocolCard } from "./TaskChatProtocolCard";
import { TaskChatPlanPreviewCard } from "./TaskChatPlanPreviewCard";
import { TaskChatThinking } from "./TaskChatThinking";
import { TaskChatToolCard } from "./TaskChatToolCard";
import {
  protocolActivityIsRunning,
  protocolActivityLabel,
  protocolActivityPresentation,
} from "./task-chat-activity-presentation";
import {
  isTerminalRunStatus,
  paperclipRunnerActivityItems,
} from "./transcript-adapter";
import { toolTaxonomy } from "./tool-taxonomy";

function lastOf<T extends TaskChatItem>(items: readonly TaskChatItem[], predicate: (item: TaskChatItem) => item is T): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (predicate(item)) return item;
  }
  return undefined;
}

function isHeadlineProtocolActivity(item: TaskChatItem): item is TaskChatProtocolItem {
  return item.kind === "protocol" && protocolActivityPresentation(item) !== null;
}

function latestPlanActivity(items: readonly TaskChatItem[]): TaskChatProviderActivityItem | undefined {
  let latest: TaskChatProviderActivityItem | undefined;
  let latestOrder = -1;
  for (const [index, item] of items.entries()) {
    if (item.kind !== "protocol" || item.surface !== "provider_activity" || item.family !== "plan") continue;
    const order = item.transcriptIndex ?? index;
    if (order >= latestOrder) {
      latest = item;
      latestOrder = order;
    }
  }
  return latest;
}

function providerPlanRevision(activity: TaskChatProviderActivityItem): number | null {
  const detail = activity.details.find(({ label }) =>
    label === "Revision" || label === "Document Revision",
  );
  if (!detail) return null;
  const revision = Number.parseInt(detail.value, 10);
  return Number.isFinite(revision) ? revision : null;
}

type FoldedNarration =
  | { kind: "commentary"; item: TaskChatMessageItem; order: number }
  | {
      kind: "reasoning";
      item: TaskChatThinkingItem;
      line: string | null;
      lineIndex: number;
      order: number;
    };

function latestFoldedNarration(items: readonly TaskChatItem[]): FoldedNarration | null {
  let latest: FoldedNarration | null = null;
  for (const [index, item] of items.entries()) {
    const order = item.kind === "message" || item.kind === "thinking"
      ? item.transcriptIndex ?? index
      : -1;
    if (item.kind === "message" && item.interstitial && item.text.trim()) {
      if (!latest || order >= latest.order) latest = { kind: "commentary", item, order };
      continue;
    }
    if (item.kind !== "thinking") continue;
    let lineIndex = -1;
    for (let candidate = item.lines.length - 1; candidate >= 0; candidate -= 1) {
      if (item.lines[candidate]?.trim()) {
        lineIndex = candidate;
        break;
      }
    }
    if (!latest || order >= latest.order) {
      latest = {
        kind: "reasoning",
        item,
        line: lineIndex < 0 ? null : item.lines[lineIndex]!.trim(),
        lineIndex,
        order,
      };
    }
  }
  return latest;
}

function FoldedReasoningTicker({
  logicalKey,
  text,
}: {
  logicalKey: string;
  text: string;
}) {
  const [ticker, setTicker] = useState({
    logicalKey,
    motionKey: 0,
    current: text,
    exiting: null as string | null,
  });
  if (ticker.logicalKey !== logicalKey) {
    setTicker({
      logicalKey,
      motionKey: ticker.motionKey + 1,
      current: text,
      exiting: ticker.current,
    });
  } else if (ticker.current !== text) {
    // Token fragments update the mounted line. Only the logical key advances
    // the slide motion (a newline or a new reasoning block).
    setTicker({ ...ticker, current: text });
  }

  return (
    <div className="flex min-w-0 gap-2 px-1 py-1.5" data-testid="task-chat-reasoning-ticker">
      <div className="flex shrink-0 items-center">
        <Brain className="h-3.5 w-3.5 text-muted-foreground/50" aria-hidden />
      </div>
      <div className="relative h-5 min-w-0 flex-1 overflow-hidden">
        {ticker.exiting !== null ? (
          <span
            key={`out-${ticker.motionKey}`}
            className="cot-line-exit absolute inset-x-0 truncate text-(length:--text-compact) italic leading-5 text-muted-foreground"
            onAnimationEnd={() => setTicker((current) => ({ ...current, exiting: null }))}
          >
            {ticker.exiting}
          </span>
        ) : null}
        <span
          key={`in-${ticker.motionKey}`}
          className={cn(
            "absolute inset-x-0 truncate text-(length:--text-compact) italic leading-5 text-muted-foreground",
            ticker.motionKey > 0 && "cot-line-enter",
          )}
          aria-live="polite"
          aria-atomic="true"
        >
          {ticker.current}
        </span>
      </div>
    </div>
  );
}

function FoldedLiveNarration({ narration }: { narration: FoldedNarration }) {
  if (narration.kind === "reasoning") {
    if (!narration.line) return null;
    return (
      <FoldedReasoningTicker
        logicalKey={`${narration.item.id}:${narration.lineIndex}`}
        text={narration.line}
      />
    );
  }
  return (
    <div
      key={narration.item.id}
      className="tc-enter-cot-line min-w-0 px-1 py-1.5 text-sm text-foreground/90"
      data-testid="task-chat-progress-update"
    >
      <MarkdownBody softBreaks linkIssueReferences>{narration.item.text}</MarkdownBody>
    </div>
  );
}

function formatCompactDuration(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function terminalStatusFailed(status: string): boolean {
  return status === "failed"
    || status === "cancelled"
    || status === "timed_out"
    || status === "interrupted";
}

function RunnerActivityTimeline({ items }: { items: readonly TaskChatItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="relative ml-4 min-w-0 pl-3">
      <span className="absolute inset-y-1 left-0 w-px bg-border/70" aria-hidden data-testid="task-chat-runner-activity-rail" />
      <ol className="flex min-w-0 flex-col gap-2 py-1" aria-label="Run activity" data-testid="task-chat-runner-activity-list">
        {items.map((item) => (
          <li className="min-w-0" key={item.id} data-activity-item-id={item.id}>
            {item.kind === "message" ? (
              <div className="tc-enter-cot-line min-w-0 px-1 text-sm text-foreground/90" data-testid="task-chat-activity-commentary">
                <MarkdownBody softBreaks linkIssueReferences>{item.text}</MarkdownBody>
              </div>
            ) : item.kind === "thinking" ? (
              <TaskChatThinking item={item} defaultOpen={false} rowClassName="px-0" />
            ) : item.kind === "tool" ? (
              <TaskChatToolCard item={item} />
            ) : item.kind === "marker" ? (
              <RunnerActivityMarker item={item} />
            ) : item.kind === "protocol" ? (
              <TaskChatProtocolActivityRow item={item} />
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function RunnerActivityMarker({ item }: { item: TaskChatMarkerItem }) {
  return (
    <div className="flex min-h-6 min-w-0 items-center gap-2 py-1 text-xs text-destructive">
      <OctagonX className="h-3.5 w-3.5 shrink-0" aria-hidden data-testid="task-chat-marker-icon" />
      <span className="shrink-0 font-medium">{item.label}</span>
      {item.detail ? <span className="min-w-0 truncate text-muted-foreground">{item.detail}</span> : null}
    </div>
  );
}

function RunnerActivityDisclosure({
  items,
  status,
  startedAtMs,
  finishedAtMs,
  open,
  onToggle,
  controlsId,
}: {
  items: readonly TaskChatItem[];
  status: string;
  startedAtMs: number | null;
  finishedAtMs?: number | null;
  open: boolean;
  onToggle: () => void;
  controlsId: string;
}) {
  const terminal = isTerminalRunStatus(status);
  useSecondTick(!terminal && startedAtMs != null);
  const elapsedMs = startedAtMs == null
    ? null
    : Math.max(0, (terminal ? finishedAtMs ?? Date.now() : Date.now()) - startedAtMs);
  const elapsed = formatCompactDuration(elapsedMs);
  const activity = lastOf<TaskChatThinkingItem | TaskChatToolItem | TaskChatProtocolItem>(
    items,
    (item): item is TaskChatThinkingItem | TaskChatToolItem | TaskChatProtocolItem =>
      item.kind === "thinking" || item.kind === "tool" || isHeadlineProtocolActivity(item),
  );

  let Icon: ComponentType<SVGProps<SVGSVGElement>> | null = null;
  let label = "Thinking";
  let detail: string | undefined;
  let active = !terminal;
  let family: string | undefined;
  if (terminal) {
    const failed = terminalStatusFailed(status);
    Icon = failed ? X : Check;
    label = failed ? "Stopped" : "Worked";
    active = false;
  } else if (activity?.kind === "tool") {
    const taxonomy = toolTaxonomy(activity.rawName ?? activity.name);
    Icon = taxonomy.icon;
    label = taxonomy.verbLabel;
    detail = activity.target;
    active = activity.status === "pending" || activity.status === "in_progress";
  } else if (activity?.kind === "protocol") {
    const presentation = protocolActivityPresentation(activity);
    if (presentation) {
      Icon = presentation.icon;
      label = protocolActivityLabel(activity, presentation);
      detail = presentation.detail;
      active = protocolActivityIsRunning(activity);
      family = activity.surface === "provider_activity" ? activity.family : activity.surface;
    }
  }

  const semanticLabel = terminal && elapsed
    ? `${label} ${terminalStatusFailed(status) ? "after" : "for"} ${elapsed}`
    : label;
  const showLiveEllipsis = active && Icon !== null;
  const expandable = items.length > 0;
  const content = (
    <>
      {Icon ? (
        <Icon className={cn("h-3.5 w-3.5 shrink-0", active && "text-(--status-agent-running)")} aria-hidden data-testid="task-chat-current-activity-icon" />
      ) : (
        <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
      )}
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span
          className={cn("shrink-0 font-medium", active && "shimmer-text shimmer-text-muted")}
          aria-live="polite"
          aria-atomic="true"
          data-testid="task-chat-current-activity-label"
        >
          {semanticLabel}{showLiveEllipsis ? "…" : ""}
        </span>
        {!terminal && elapsed ? <span className="shrink-0 font-mono text-(length:--text-micro)" aria-hidden>· {elapsed}</span> : null}
        {detail ? <span className="min-w-0 truncate font-mono text-(length:--text-micro)">{detail}</span> : null}
      </span>
      {expandable ? (
        <ChevronRight
          className={cn(
            "tc-hover-disclosure-caret h-3.5 w-3.5 shrink-0 transition-[opacity,transform] group-hover/disclosure:opacity-80 group-focus-visible/disclosure:opacity-80",
            open ? "rotate-90 opacity-80" : "opacity-0",
          )}
          aria-hidden
          data-testid="task-chat-runner-disclosure-caret"
        />
      ) : null}
    </>
  );

  return expandable ? (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controlsId}
      aria-label={`${open ? "Collapse" : "Expand"} run activity: ${semanticLabel}`}
      className="group/disclosure flex min-h-8 w-full min-w-0 items-center gap-2 rounded-sm py-1.5 pl-7 pr-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:bg-muted/60 focus-visible:text-foreground focus-visible:outline-none"
      data-testid="task-chat-current-activity"
      data-activity-family={family}
    >
      {content}
    </button>
  ) : (
    <div className="flex min-h-8 min-w-0 items-center gap-2 py-1.5 pl-7 pr-1 text-sm text-muted-foreground" data-testid="task-chat-current-activity" data-activity-family={family}>
      {content}
    </div>
  );
}

export function TaskChatRunnerTurn({
  runId,
  agentName,
  agentIcon,
  items,
  status,
  startedAtMs,
  finishedAtMs,
  planDocument,
  onRuntimeRequestDecision,
}: {
  /** Stable identity used to clear replay-latched final text for the next turn. */
  runId?: string | null;
  agentName?: string | null;
  agentIcon?: string | null;
  items: readonly TaskChatItem[];
  status: string;
  startedAtMs: number | null;
  finishedAtMs?: number | null;
  /** Current canonical Plan revision, used to replace a streamed provider draft. */
  planDocument?: IssueDocument | null;
  onRuntimeRequestDecision?: (
    item: TaskChatRuntimeRequestItem,
    decision: TaskChatRuntimeRequestDecision,
  ) => void | Promise<void>;
}) {
  const terminal = isTerminalRunStatus(status);
  const [disclosure, setDisclosure] = useState({ runId, terminal, open: false });
  if (disclosure.runId !== runId || disclosure.terminal !== terminal) {
    setDisclosure({ runId, terminal, open: terminal ? false : disclosure.runId === runId && disclosure.open });
  }
  const open = disclosure.runId === runId && disclosure.terminal === terminal ? disclosure.open : false;
  const controlsId = `task-chat-run-activity-${useId().replaceAll(":", "")}`;
  const activityItems = paperclipRunnerActivityItems(items);
  const pendingRuntimeRequest = lastOf<TaskChatRuntimeRequestItem>(
    items,
    (item): item is TaskChatRuntimeRequestItem => item.kind === "protocol"
      && item.surface === "runtime_request"
      && item.status === "pending",
  );
  const narration = latestFoldedNarration(items);
  const livePlan = latestPlanActivity(activityItems);
  const livePlanRevision = livePlan ? providerPlanRevision(livePlan) : null;
  const canonicalPlanUpdatedDuringRun = Boolean(
    planDocument
    && startedAtMs != null
    && new Date(planDocument.updatedAt).getTime() >= startedAtMs
    && (livePlanRevision == null || planDocument.latestRevisionNumber >= livePlanRevision),
  );
  const observedFinal = lastOf<TaskChatMessageItem>(items, (item): item is TaskChatMessageItem => item.kind === "message" && item.channel === "final");
  // A reconnect/replay can briefly rebuild the transcript without the final
  // item (or with an earlier, shorter prefix). Once durable answer text is on
  // screen it must be monotonic for the lifetime of this mounted turn.
  const finalRef = useRef<{ runId?: string | null; item?: TaskChatMessageItem }>({ runId });
  if (finalRef.current.runId !== runId) finalRef.current = { runId };
  if (observedFinal && (!finalRef.current.item || observedFinal.text.length >= finalRef.current.item.text.length)) {
    finalRef.current.item = observedFinal;
  }
  const final = finalRef.current.item;

  return (
    <div className="flex min-w-0 flex-col" data-testid="task-chat-runner-turn" data-phase={status === "queued" ? "startup" : undefined}>
      {agentName ? (
        <div className={status === "queued" ? "pb-1" : "pb-1 pt-2"} data-testid="task-chat-runner-identity-row">
          <TaskChatAgentIdentity agentName={agentName} agentIcon={agentIcon} />
        </div>
      ) : null}
      {!open && !terminal && livePlan && !canonicalPlanUpdatedDuringRun ? (
        <div className="py-1" data-testid="task-chat-live-plan-preview">
          <TaskChatPlanPreviewCard source={{ kind: "live", activity: livePlan }} />
        </div>
      ) : null}
      {!open && narration && !final && !terminal ? (
        <div className="flex min-w-0 flex-col py-1" data-testid="task-chat-live-narration">
          <FoldedLiveNarration narration={narration} />
        </div>
      ) : null}
      <RunnerActivityDisclosure
        items={activityItems}
        status={status}
        startedAtMs={startedAtMs}
        finishedAtMs={finishedAtMs}
        open={open}
        onToggle={() => setDisclosure((current) => ({ ...current, open: !current.open }))}
        controlsId={controlsId}
      />
      <div
        id={controlsId}
        className="tc-turn-fold"
        data-folded={open ? "false" : "true"}
        aria-hidden={!open}
        inert={open ? undefined : true}
      >
        <div>
          <div className="py-1">
            <RunnerActivityTimeline items={activityItems} />
          </div>
        </div>
      </div>
      {pendingRuntimeRequest ? (
        <div className="py-1">
          <TaskChatProtocolCard item={pendingRuntimeRequest} onRuntimeRequestDecision={onRuntimeRequestDecision} />
        </div>
      ) : null}
      {final ? (
        <div className="tc-enter-bubble w-full" data-testid="task-chat-final-response">
          <div className="break-words px-1 py-2 text-sm text-foreground" data-testid="task-chat-agent-bubble">
            <MarkdownBody softBreaks linkIssueReferences>{final.text}</MarkdownBody>
          </div>
        </div>
      ) : null}
    </div>
  );
}
