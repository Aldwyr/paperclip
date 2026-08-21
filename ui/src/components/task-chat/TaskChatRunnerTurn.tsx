import { useRef, useState } from "react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { cn } from "@/lib/utils";
import type { TaskChatItem, TaskChatMessageItem, TaskChatThinkingItem, TaskChatToolItem } from "./task-chat-model";
import { TaskChatAgentIdentity } from "./TaskChatBubble";
import { TaskChatLiveRunPill } from "./TaskChatLiveRunPill";
import { TaskChatLiveTail } from "./TaskChatLiveTail";
import { paperclipRunnerHistoryItems } from "./transcript-adapter";
import { toolTaxonomy } from "./tool-taxonomy";

function lastOf<T extends TaskChatItem>(items: readonly TaskChatItem[], predicate: (item: TaskChatItem) => item is T): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (predicate(item)) return item;
  }
  return undefined;
}

function CurrentActivity({ items }: { items: readonly TaskChatItem[] }) {
  const activity = lastOf<TaskChatThinkingItem | TaskChatToolItem>(
    items,
    (item): item is TaskChatThinkingItem | TaskChatToolItem => item.kind === "thinking" || item.kind === "tool",
  );
  if (!activity || activity.kind === "thinking") {
    return (
      <div className="px-1 py-1.5 text-sm text-muted-foreground" data-testid="task-chat-current-activity">
        <span className="shimmer-text shimmer-text-muted">Thinking</span>
      </div>
    );
  }
  const taxonomy = toolTaxonomy(activity.rawName ?? activity.name);
  const Icon = taxonomy.icon;
  const active = activity.status === "pending" || activity.status === "in_progress";
  return (
    <div className="flex min-w-0 items-center gap-2 px-1 py-1.5 text-sm text-muted-foreground" data-testid="task-chat-current-activity">
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className={cn("shrink-0", active && "shimmer-text shimmer-text-muted")}>{taxonomy.verbLabel}</span>
      {activity.target ? <span className="min-w-0 truncate font-mono text-xs">{activity.target}</span> : null}
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
  toolSummary,
}: {
  /** Stable identity used to clear replay-latched final text for the next turn. */
  runId?: string | null;
  agentName?: string | null;
  agentIcon?: string | null;
  items: readonly TaskChatItem[];
  status: string;
  startedAtMs: number | null;
  finishedAtMs?: number | null;
  toolSummary: string | null;
}) {
  const [open, setOpen] = useState(false);
  const historyItems = paperclipRunnerHistoryItems(items);
  const progress = lastOf<TaskChatMessageItem>(items, (item): item is TaskChatMessageItem => item.kind === "message" && Boolean(item.interstitial));
  const observedFinal = lastOf<TaskChatMessageItem>(items, (item): item is TaskChatMessageItem => item.kind === "message" && item.channel === "final");
  // A reconnect/replay can briefly rebuild the transcript without the final
  // item (or with an earlier, shorter prefix). Once durable answer text is on
  // screen it must be monotonic for the lifetime of this mounted turn.
  const finalRef = useRef<{ runId?: string | null; item?: TaskChatMessageItem }>({ runId });
  if (finalRef.current.runId !== runId) {
    finalRef.current = { runId };
  }
  if (observedFinal && (!finalRef.current.item || observedFinal.text.length >= finalRef.current.item.text.length)) {
    finalRef.current.item = observedFinal;
  }
  const final = finalRef.current.item;

  if (status === "queued") {
    return (
      <div className="flex flex-col gap-1 py-1" data-testid="task-chat-runner-turn" data-phase="startup">
        {agentName ? <TaskChatAgentIdentity agentName={agentName} agentIcon={agentIcon} /> : null}
        <CurrentActivity items={items} />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col" data-testid="task-chat-runner-turn">
      <TaskChatLiveRunPill
        status={status}
        startedAtMs={startedAtMs}
        finishedAtMs={finishedAtMs}
        toolSummary={toolSummary}
        runnerStyle
        expanded={open}
        onToggle={() => setOpen((value) => !value)}
      />
      {agentName ? (
        <div className="pt-2" data-testid="task-chat-runner-identity-row">
          <TaskChatAgentIdentity agentName={agentName} agentIcon={agentIcon} />
        </div>
      ) : null}
      <div className="tc-turn-fold" data-folded={open ? "false" : "true"} aria-hidden={!open}>
        <div>
          <div className="flex flex-col gap-2 py-2">
            <TaskChatLiveTail items={historyItems} excludeFinal />
          </div>
        </div>
      </div>
      {!open ? (
        <div className="flex min-w-0 flex-col py-1">
          {progress ? (
            <div className="tc-enter-cot-line min-w-0 px-1 py-1.5 text-sm text-foreground/90" data-testid="task-chat-progress-update">
              <MarkdownBody softBreaks linkIssueReferences>{progress.text}</MarkdownBody>
            </div>
          ) : null}
          {!final ? <CurrentActivity items={items} /> : null}
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
