import { ChevronRight, Loader2 } from "lucide-react";
import type { TranscriptEntry } from "../../adapters";
import { cn } from "@/lib/utils";
import { useSecondTick } from "@/hooks/useSecondTick";
import { formatDurationWords } from "@/lib/issue-chat-messages";
import { isCommandTool } from "@/lib/transcriptPresentation";
import { isTerminalRunStatus } from "@/components/task-chat/transcript-adapter";

/**
 * "ran N commands, called M tools" for the live tail's status pill, counted off
 * the streamed transcript entries. Mirrors IssueChatThread's `toolCountSummary`
 * (which counts a settled message's tool-call parts) so the experimental live
 * tail reads the same as the default view. Streaming runtimes re-emit a
 * tool_call as its status progresses, so calls carrying a `toolUseId` are
 * counted once.
 */
export function toolCountSummaryFromEntries(entries: readonly TranscriptEntry[]): string | null {
  const seen = new Set<string>();
  let commands = 0;
  let other = 0;
  for (const entry of entries) {
    if (entry.kind !== "tool_call") continue;
    if (entry.toolUseId) {
      if (seen.has(entry.toolUseId)) continue;
      seen.add(entry.toolUseId);
    }
    if (isCommandTool(entry.name, entry.input)) commands += 1;
    else other += 1;
  }
  const parts: string[] = [];
  if (commands > 0) parts.push(`ran ${commands} command${commands === 1 ? "" : "s"}`);
  if (other > 0) parts.push(`called ${other} tool${other === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Status pill for the experimental chat-style view's live tail (PAP-461, A1).
 *
 * Byte-for-byte the same affordance the default view shows above a run's chain
 * of thought (IssueChatThread's CoT header): a spinner + shimmering "Working"
 * verb + elapsed words + "· called N tools" while the run streams, settling to
 * a static emerald dot + "Worked" summary once it terminates. The verb shimmers
 * via `.shimmer-text` (reduced-motion aware) exactly as the default view does.
 */
export function TaskChatLiveRunPill({
  status,
  startedAtMs,
  finishedAtMs,
  toolSummary,
  runnerStyle = false,
  expanded,
  onToggle,
}: {
  status: string;
  /** Run start (startedAt, falling back to createdAt) in ms, or null if unknown. */
  startedAtMs: number | null;
  /** Run finish in ms once terminal; drives the settled elapsed readout. */
  finishedAtMs?: number | null;
  toolSummary: string | null;
  /** Codex-style new-runner header: no spinner, whole-second compact duration. */
  runnerStyle?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const active = !isTerminalRunStatus(status);
  // One shared page-wide ticker drives the live elapsed readout, matching the
  // default view's `useLiveElapsed`.
  useSecondTick(active && startedAtMs != null);

  const elapsedMs =
    startedAtMs == null ? null : (active ? Date.now() : finishedAtMs ?? Date.now()) - startedAtMs;
  const elapsed = elapsedMs != null
    ? runnerStyle
      ? `${Math.max(0, Math.floor(elapsedMs / 1000))}s`
      : formatDurationWords(elapsedMs)
    : null;
  const verb = active ? "Working" : "Worked";
  const suffix = elapsed ? `for ${elapsed}` : null;

  if (runnerStyle) {
    const content = (
      <>
        <span className="text-sm font-medium text-foreground/80">{verb}</span>
        {suffix ? <span className="text-sm text-muted-foreground">{suffix}</span> : null}
        {!active ? (
          <ChevronRight
            className={cn("ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform", expanded && "rotate-90")}
            aria-hidden
          />
        ) : null}
      </>
    );
    return onToggle && !active ? (
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full min-w-0 items-center gap-1.5 border-b border-border/70 px-1 py-2 text-left transition-colors hover:text-foreground"
        data-testid="task-chat-live-run-pill"
      >
        {content}
      </button>
    ) : (
      <div className="flex min-w-0 items-center gap-1.5 border-b border-border/70 px-1 py-2" data-testid="task-chat-live-run-pill">
        {content}
      </div>
    );
  }

  return (
    <div
      className="flex min-w-0 items-center gap-2.5 px-1 py-2"
      data-testid="task-chat-live-run-pill"
    >
      <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground/80">
        {active ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/70" />
          </span>
        )}
        {active ? <span className={cn("shimmer-text")}>{verb}</span> : verb}
      </span>
      {suffix ? <span className="text-xs text-muted-foreground/60">{suffix}</span> : null}
      {toolSummary ? <span className="text-xs text-muted-foreground/40">· {toolSummary}</span> : null}
    </div>
  );
}
