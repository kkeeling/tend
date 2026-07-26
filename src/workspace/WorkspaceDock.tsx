import { useEffect, useRef, useState } from "react";
import type { WorkspaceNowItem } from "../types";
import { workspaceItemKey } from "./workspaceKeys";
import type { WorkspaceContinuityStore } from "./continuityStore";

function itemKey(item?: WorkspaceNowItem): string | null {
  return item ? workspaceItemKey(item) : null;
}

export function WorkspaceDock({
  item,
  onSubmit,
  disabled = false,
  continuityStore,
}: {
  item?: WorkspaceNowItem;
  onSubmit: (instruction: string) => Promise<boolean>;
  disabled?: boolean;
  continuityStore: WorkspaceContinuityStore;
}) {
  const workspaceDrafts = continuityStore.instructionDrafts;
  const key = itemKey(item);
  const [value, setValue] = useState(() => key ? workspaceDrafts.get(key) ?? "" : "");
  const [submitting, setSubmitting] = useState(false);
  const [recovery, setRecovery] = useState<{ key: string; value: string } | null>(null);
  const previousKey = useRef<string | null>(key);

  useEffect(() => {
    const priorKey = previousKey.current;
    if (priorKey && priorKey !== key) {
      const priorDraft = workspaceDrafts.get(priorKey)?.trim();
      if (priorDraft) setRecovery({ key: priorKey, value: workspaceDrafts.get(priorKey) ?? "" });
    }
    previousKey.current = key;
    setValue(key ? workspaceDrafts.get(key) ?? "" : "");
  }, [key]);

  const updateValue = (next: string) => {
    setValue(next);
    if (key) {
      if (next) continuityStore.setInstructionDraft(key, next);
      else workspaceDrafts.delete(key);
    }
  };
  const submit = async () => {
    const instruction = value.trim();
    if (!instruction || !item || !key || disabled || submitting) return;
    setSubmitting(true);
    try {
      const acknowledged = await onSubmit(instruction);
      if (!acknowledged) return;
      workspaceDrafts.delete(key);
      if (previousKey.current === key) setValue("");
      if (recovery?.key === key) setRecovery(null);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="dock workspace-dock">
      <div className="dock-inner scope-card">
        <div className="dock-context"><span className="listening-dot" /><b>Card</b><span className="dock-target">{item ? `${item.card.title} · ${item.cardRef.feedId}` : "Select a card"}</span></div>
        {recovery && recovery.key !== key && (
          <div className="dock-recovery" role="status" aria-live="polite">
            <span>An unsent instruction from the previous card was preserved.</span>
            <button
              className="button ghost"
              type="button"
              disabled={!item || disabled || submitting}
              onClick={() => {
                updateValue(recovery.value);
                setRecovery(null);
              }}
            >
              Restore for review
            </button>
          </div>
        )}
        <div className="dock-row">
          <textarea
            aria-label="Card instruction"
            aria-busy={submitting}
            disabled={!item || disabled || submitting}
            placeholder={item ? disabled ? "Refresh current state before acting" : "Ask about or instruct this card…" : "Select a card to start"}
            value={value}
            onInput={(event) => updateValue(event.currentTarget.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit();
            }}
          />
          <button className="button primary" disabled={!item || disabled || submitting || !value.trim()} onClick={() => void submit()}>
            {submitting ? "Sending…" : "Send"}
          </button>
        </div>
        <div className="dock-footer"><span className="dock-hints">Routes to the owning feed · ⌘ Enter to send</span></div>
      </div>
    </div>
  );
}
