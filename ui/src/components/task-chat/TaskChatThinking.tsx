import { useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownBody } from "@/components/MarkdownBody";
import type { TaskChatThinkingItem } from "./task-chat-model";

/** Provider-authored reasoning summaries and deltas; never reconstructed hidden reasoning. */
export function TaskChatThinking({ item }: { item: TaskChatThinkingItem }) {
  const [open, setOpen] = useState(item.streaming || !item.collapsed);
  const body = item.lines.join("\n").trim();
  if (!body) return null;
  const label = item.streaming ? "Reasoning…" : item.summaryLabel ?? "Reasoning";

  return (
    <div className="flex min-w-0 flex-col text-xs" data-testid="task-chat-thinking">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="group flex min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Brain className={cn("h-3.5 w-3.5 shrink-0", item.streaming && "text-(--status-agent-running)")} aria-hidden />
        <span>{label}</span>
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} aria-hidden />
      </button>
      {open ? (
        <div className="ml-2.5 mt-1 border-l-2 border-border pl-2.5 text-muted-foreground">
          <MarkdownBody softBreaks linkIssueReferences>{body}</MarkdownBody>
        </div>
      ) : null}
    </div>
  );
}
