import { useId, useState, type ReactNode } from "react";
import {
  Check,
  ChevronRight,
  Circle,
  ExternalLink,
  Loader2,
  X,
} from "lucide-react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { WorkspaceFileLink } from "@/components/WorkspaceFileLink";
import { cn } from "@/lib/utils";
import type {
  TaskChatProtocolItem,
  TaskChatProtocolStep,
  TaskChatProviderActivityItem,
  TaskChatWorkspaceChangeItem,
  TaskChatWorkspaceFileItem,
} from "./task-chat-model";
import {
  protocolActivityIsRunning,
  protocolActivityLabel,
  protocolActivityPresentation,
} from "./task-chat-activity-presentation";

function StatusIcon({ status }: { status: "running" | "completed" | "failed" | "interrupted" | "informational" }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-(--status-agent-running)" aria-hidden />;
  if (status === "failed" || status === "interrupted") return <X className="h-3.5 w-3.5 text-destructive" aria-hidden />;
  if (status === "completed") return <Check className="h-3.5 w-3.5 text-(--status-task-icon-done)" aria-hidden />;
  return <Circle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />;
}

function stepStatusIcon(status: TaskChatProtocolStep["status"]) {
  if (status === "in_progress") return <Loader2 className="h-3 w-3 animate-spin text-(--status-agent-running)" aria-hidden />;
  if (status === "completed") return <Check className="h-3 w-3 text-(--status-task-icon-done)" aria-hidden />;
  if (status === "blocked" || status === "failed") return <X className="h-3 w-3 text-destructive" aria-hidden />;
  return <Circle className="h-3 w-3 text-muted-foreground" aria-hidden />;
}

function ProviderDetails({ item }: { item: TaskChatProviderActivityItem }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {item.steps.length > 0 ? (
        <ol className="flex flex-col gap-1" aria-label="Plan steps">
          {item.steps.map((step) => (
            <li className="flex min-w-0 items-start gap-2" key={step.id}>
              <span className="mt-0.5 shrink-0">{stepStatusIcon(step.status)}</span>
              <span className={cn("min-w-0", step.status === "completed" && "text-muted-foreground line-through")}>{step.label}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {item.links.length > 0 ? (
        <ul className="flex flex-col gap-1.5" aria-label="Research sources">
          {item.links.map((link) => (
            <li key={link.href}>
              <a className="inline-flex min-w-0 items-center gap-1 font-medium text-primary hover:underline" href={link.href} target="_blank" rel="noreferrer">
                <span className="truncate">{link.label}</span>
                <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
              </a>
              {link.description ? <p className="mt-0.5 text-muted-foreground">{link.description}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {item.children.length > 0 ? (
        <ul className="flex flex-col gap-1.5" aria-label="Delegated agents">
          {item.children.map((child) => (
            <li className="flex min-w-0 flex-col gap-0.5" key={child.id}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="font-medium text-foreground">{child.title}</span>
                <span className="capitalize text-muted-foreground">{child.status}</span>
                {child.metadata ? <span className="min-w-0 truncate font-mono text-(length:--text-micro)">{child.metadata}</span> : null}
              </span>
              {child.summary ? <span className="text-muted-foreground">{child.summary}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {item.details.length > 0 ? (
        <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-(--gtc-2)">
          {item.details.map((detail) => (
            <div className="contents" key={`${detail.label}:${detail.value}`}>
              <dt className="text-muted-foreground">{detail.label}</dt>
              <dd className={cn("min-w-0 break-words text-foreground", detail.mono && "font-mono")}>{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {item.output ? (
        <pre className="max-h-(--sz-64) overflow-auto whitespace-pre-wrap rounded-sm bg-muted/50 p-2 font-mono text-(length:--text-micro) text-foreground">{item.output}</pre>
      ) : null}
      {item.outputTruncated ? <p className="text-muted-foreground">Output truncated to 8 KiB.</p> : null}
    </div>
  );
}

function WorkspaceChangeDetails({ item }: { item: TaskChatWorkspaceChangeItem }) {
  return item.files.length > 0 ? (
    <ul className="flex min-w-0 flex-col gap-2" aria-label="Changed files">
      {item.files.map((file) => (
        <li className="flex min-w-0 flex-col gap-1" key={`${file.operation}:${file.path}`}>
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-foreground">
              {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
            </span>
            <span className="shrink-0 capitalize text-muted-foreground">{file.operation.replaceAll("_", " ")}</span>
            {file.additions != null || file.deletions != null ? (
              <span className="shrink-0 font-mono text-(length:--text-micro) text-muted-foreground">
                {file.additions == null ? "" : `+${file.additions}`} {file.deletions == null ? "" : `−${file.deletions}`}
              </span>
            ) : null}
          </span>
          {file.diff ? <pre className="max-h-(--sz-64) overflow-auto whitespace-pre-wrap rounded-sm bg-muted/50 p-2 font-mono text-(length:--text-micro) text-foreground">{file.diff}</pre> : null}
        </li>
      ))}
    </ul>
  ) : <p className="text-muted-foreground">No changed-file details were reported.</p>;
}

function WorkspaceFileDetails({ item }: { item: TaskChatWorkspaceFileItem }) {
  const workspaceFileRef = {
    path: item.path,
    resourceKind: "file" as const,
    line: item.line,
    column: null,
    raw: item.path,
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <WorkspaceFileLink workspaceFileRef={workspaceFileRef} label={item.path} />
      {item.preview ? (
        item.presentation === "document" ? (
          <div className="max-h-(--sz-64) overflow-auto rounded-sm bg-muted/30 p-2 text-foreground"><MarkdownBody>{item.preview}</MarkdownBody></div>
        ) : (
          <pre className="max-h-(--sz-64) overflow-auto whitespace-pre-wrap rounded-sm bg-muted/50 p-2 font-mono text-(length:--text-micro) text-foreground">{item.preview}</pre>
        )
      ) : <p className="text-muted-foreground">Preview unavailable.</p>}
      {item.previewTruncated ? <p className="text-muted-foreground">Preview truncated by the runner.</p> : null}
    </div>
  );
}

function detailContent(item: TaskChatProtocolItem): ReactNode | null {
  switch (item.surface) {
    case "provider_activity": {
      const expandable = item.details.length > 0 || item.steps.length > 0 || item.links.length > 0 || item.children.length > 0 || Boolean(item.output) || Boolean(item.outputTruncated);
      return expandable ? <ProviderDetails item={item} /> : null;
    }
    case "workspace_change": return <WorkspaceChangeDetails item={item} />;
    case "workspace_file": return <WorkspaceFileDetails item={item} />;
    case "resource":
    case "runtime_request":
    case "run_result":
    case "run_terminal":
      return null;
  }
}

function itemStatus(item: TaskChatProtocolItem): "running" | "completed" | "failed" | "interrupted" | "informational" {
  if (item.surface === "provider_activity") return item.status;
  if (item.surface === "workspace_change") return item.complete ? "completed" : "running";
  return "completed";
}

export function TaskChatProtocolActivityRow({ item }: { item: TaskChatProtocolItem }) {
  const [open, setOpen] = useState(false);
  const detailId = `task-chat-protocol-activity-${useId().replaceAll(":", "")}`;
  const presentation = protocolActivityPresentation(item);
  if (!presentation) return null;
  const detail = detailContent(item);
  const expandable = detail !== null;
  const Icon = presentation.icon;
  const label = protocolActivityLabel(item, presentation);
  const active = protocolActivityIsRunning(item);
  const status = itemStatus(item);
  const row = (
    <>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden data-testid="task-chat-protocol-activity-icon" />
      <span className={cn("shrink-0 font-medium", active && "shimmer-text shimmer-text-muted")}>{label}{active ? "…" : ""}</span>
      {presentation.detail ? <span className="min-w-0 truncate font-mono text-(length:--text-micro)">{presentation.detail}</span> : null}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {expandable ? (
          <ChevronRight
            className={cn("tc-hover-disclosure-caret h-3 w-3 transition-[opacity,transform] group-hover/activity:opacity-80 group-focus-visible/activity:opacity-80", open ? "rotate-90 opacity-80" : "opacity-0")}
            aria-hidden
          />
        ) : null}
        <StatusIcon status={status} />
      </span>
    </>
  );

  if (item.surface === "resource" && item.href) {
    return (
      <a className="group/activity -mx-1.5 flex min-h-6 min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground" href={item.href} data-testid="task-chat-protocol-activity-row">
        {row}
      </a>
    );
  }

  const activityRow = expandable ? (
    <button
      type="button"
      onClick={() => setOpen((value) => !value)}
      aria-expanded={open}
      aria-controls={detailId}
      className="group/activity -mx-1.5 flex min-h-6 min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 text-left text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {row}
    </button>
  ) : (
    <div className="group/activity -mx-1.5 flex min-h-6 min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 text-muted-foreground">
      {row}
    </div>
  );

  return (
    <div className="flex min-w-0 flex-col text-xs" data-testid="task-chat-protocol-activity-row" data-activity-family={item.surface === "provider_activity" ? item.family : item.surface}>
      {activityRow}
      {open && detail ? (
        <div id={detailId} className="ml-2.5 mt-0.5 border-l-2 border-border py-1 pl-2.5" data-testid="task-chat-protocol-activity-detail">
          {detail}
        </div>
      ) : null}
    </div>
  );
}
