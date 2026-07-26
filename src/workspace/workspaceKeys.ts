import type { WorkspaceNowItem } from "../types";

export function workspaceItemKey(item: WorkspaceNowItem): string {
  return `${item.cardRef.feedId}\u0000${item.cardRef.cardId}`;
}
