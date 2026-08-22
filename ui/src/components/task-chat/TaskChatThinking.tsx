import { useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownBody } from "@/components/MarkdownBody";
import type { TaskChatThinkingItem } from "./task-chat-model";

/** Provider-authored reasoning summaries and deltas; never reconstructed hidden reasoning. */
export function TaskChatThinking({
  item,
  defaultOpen,
  rowClassName,
}: {
  item: TaskChatThinkingItem;
  /** Activity timelines keep reasoning as one compact row until requested. */
  defaultOpen?: boolean;
  /** Optional alignment override for a containing activity rail. */
  rowClassName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen ?? (item.streaming || !item.collapsed));
  const body = item.lines.join("\n").trim();
  const baseLabel = item.channel === "detail" ? "Reasoning detail" : "Reasoning";
  const label = item.streaming
    ? body ? `${baseLabel}…` : "Thinking…"
    : item.summaryLabel ?? (body ? baseLabel : "Thought");

  if (!body) {
    return (
      <div className={cn("flex min-w-0 items-center gap-1.5 px-1 py-0.5 text-xs text-muted-foreground", rowClassName)} data-testid="task-chat-thinking">
        <Brain className={cn("h-3.5 w-3.5 shrink-0", item.streaming && "text-(--status-agent-running)")} aria-hidden data-testid="task-chat-thinking-icon" />
        <span className={cn(item.streaming && "shimmer-text shimmer-text-muted")}>{label}</span>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col text-xs" data-testid="task-chat-thinking">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn("group/thinking flex min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", rowClassName)}
      >
        <Brain className={cn("h-3.5 w-3.5 shrink-0", item.streaming && "text-(--status-agent-running)")} aria-hidden data-testid="task-chat-thinking-icon" />
        <span>{label}</span>
        <ChevronRight className={cn("tc-hover-disclosure-caret h-3 w-3 shrink-0 transition-[opacity,transform] group-hover/thinking:opacity-80 group-focus-visible/thinking:opacity-80", open ? "rotate-90 opacity-80" : "opacity-0")} aria-hidden />
      </button>
      {open ? (
        <div className="ml-2.5 mt-1 border-l-2 border-border pl-2.5 text-muted-foreground">
          <MarkdownBody softBreaks linkIssueReferences>{body}</MarkdownBody>
        </div>
      ) : null}
    </div>
  );
}
