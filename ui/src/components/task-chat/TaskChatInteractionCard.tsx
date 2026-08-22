import type { ComponentProps } from "react";
import type { IssueDocument } from "@paperclipai/shared";
import { IssueThreadInteractionCard } from "@/components/IssueThreadInteractionCard";
import { shouldHideInteractionCard } from "@/lib/issue-thread-interactions";
import { TaskChatCompactInteractionCard } from "./TaskChatCompactInteractionCard";
import { TaskChatMarker } from "./TaskChatMarker";
import type { TaskChatInteractionItem } from "./task-chat-model";

type InteractionCardProps = Omit<ComponentProps<typeof IssueThreadInteractionCard>, "interaction">;

export interface TaskChatInteractionCardProps extends InteractionCardProps {
  item: TaskChatInteractionItem;
  planDocument?: IssueDocument | null;
}

/**
 * Task-page presentation for durable issue interactions. The new task view uses
 * a compact, protocol-card-aligned renderer with paginated questions and
 * verdicts; the classic issue thread keeps its existing card. Tool approvals and
 * secret proposals deliberately retain the specialized shared renderer because
 * its risk, expiry, and safe-binding receipts are security-relevant.
 */
export function TaskChatInteractionCard({ item, planDocument, ...cardProps }: TaskChatInteractionCardProps) {
  const interaction = item.interaction;
  if (shouldHideInteractionCard(interaction)) return null;
  if (
    interaction.kind === "request_confirmation"
    && interaction.status === "expired"
    && !interaction.payload.secretProposal
  ) {
    return (
      <TaskChatMarker
        item={{
          id: item.id,
          kind: "marker",
          variant: "turn_boundary",
          label: interaction.title ?? "Confirmation",
          detail: "expired",
        }}
      />
    );
  }
  const useSpecializedRenderer = interaction.kind === "request_confirmation"
    && Boolean(interaction.payload.toolAction || interaction.payload.secretProposal);
  return (
    <div
      id={`interaction-${interaction.id}`}
      className="tc-enter-bubble w-full"
      data-testid="task-chat-interaction"
    >
      {useSpecializedRenderer ? (
        <IssueThreadInteractionCard interaction={interaction} primaryActionOnRight {...cardProps} />
      ) : (
        <TaskChatCompactInteractionCard
          interaction={interaction}
          planDocument={planDocument}
          {...cardProps}
        />
      )}
    </div>
  );
}
