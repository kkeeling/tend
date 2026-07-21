import type { Card } from "../types";
import { post } from "../app/api";

export async function flushVisibleCardEdits(card: Card, domId = card.id): Promise<void> {
  const selector = `[data-card-id="${CSS.escape(domId)}"] textarea[data-block-id]`;
  const textareas = document.querySelectorAll<HTMLTextAreaElement>(selector);
  await Promise.all(Array.from(textareas).map(async (textarea) => {
    const blockId = textarea.dataset.blockId;
    const block = card.blocks.find((item) => item.id === blockId);
    if (!blockId || block?.type !== "editable_text" || textarea.value === (block.value ?? "")) return;
    await post(`/api/feeds/${card.feedId}/cards/${card.id}/blocks/${blockId}`, { value: textarea.value });
  }));
}
