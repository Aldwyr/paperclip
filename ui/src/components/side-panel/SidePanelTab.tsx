import type { ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from "react";
import { X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface SidePanelTabProps {
  id: string;
  label: string;
  ariaLabel?: string;
  icon?: ReactNode;
  status?: ReactNode;
  active: boolean;
  closable?: boolean;
  disabled?: boolean;
  tabRef?: Ref<HTMLButtonElement>;
  dragHandleProps?: ButtonHTMLAttributes<HTMLButtonElement>;
  onSelect: () => void;
  onClose?: () => void;
  onAuxClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  onKeyDown?: ButtonHTMLAttributes<HTMLButtonElement>["onKeyDown"];
  className?: string;
}

export function SidePanelTab({
  id,
  label,
  ariaLabel,
  icon,
  status,
  active,
  closable = true,
  disabled = false,
  tabRef,
  dragHandleProps,
  onSelect,
  onClose,
  onAuxClick,
  onKeyDown,
  className,
}: SidePanelTabProps) {
  const closeLabel = `Close ${label}`;
  return (
    <div
      data-side-panel-tab-wrapper={id}
      data-active={active ? "true" : "false"}
      className={cn(
        "group/side-panel-tab relative flex h-9 min-w-0 shrink-0 items-center rounded-xl border border-transparent",
        "side-panel-tab-motion",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/55 hover:text-foreground",
        disabled && "opacity-50",
        className,
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            {...dragHandleProps}
            ref={tabRef}
            type="button"
            role="tab"
            data-side-panel-tab-target={id}
            id={`side-panel-tab-${id}`}
            aria-controls={`side-panel-content-${id}`}
            aria-selected={active}
            aria-label={ariaLabel ?? label}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            onClick={onSelect}
            onAuxClick={onAuxClick}
            onKeyDown={onKeyDown}
            className={cn(
              "flex h-full min-w-0 items-center gap-1.5 rounded-xl py-1.5 pl-2 text-sm font-medium outline-none",
              closable ? "pr-7" : "pr-2.5",
              "focus-visible:ring-2 focus-visible:ring-ring/60",
              dragHandleProps?.className,
            )}
          >
            {icon ? <span className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4">{icon}</span> : null}
            <span className="max-w-40 truncate">{label}</span>
            {status ? <span className="flex shrink-0 items-center">{status}</span> : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      {closable && onClose ? (
        <button
          type="button"
          aria-label={closeLabel}
          title={closeLabel}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className={cn(
            "absolute right-1 flex size-6 items-center justify-center rounded-lg text-muted-foreground outline-none",
            "side-panel-tab-motion hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
            active
              ? "opacity-100"
              : "opacity-0 group-hover/side-panel-tab:opacity-100 group-focus-within/side-panel-tab:opacity-100",
          )}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
