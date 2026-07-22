import { useEffect, useState } from "react";
import type { WorkspaceNowItem } from "../types";

export function WorkspaceDock({ item, onSubmit }: { item?: WorkspaceNowItem; onSubmit: (instruction: string) => void }) {
  const [value, setValue] = useState("");
  useEffect(() => setValue(""), [item?.id]);
  const submit = () => {
    const instruction = value.trim();
    if (!instruction || !item) return;
    onSubmit(instruction);
    setValue("");
  };
  return (
    <div className="dock workspace-dock">
      <div className="dock-inner scope-card">
        <div className="dock-context"><span className="listening-dot" /><b>Card</b><span className="dock-target">{item ? `${item.card.title} · ${item.cardRef.feedId}` : "Select a card"}</span></div>
        <div className="dock-row">
          <textarea aria-label="Card instruction" disabled={!item} placeholder={item ? "Ask about or instruct this card…" : "Select a card to start"} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submit(); }} />
          <button className="button primary" disabled={!item || !value.trim()} onClick={submit}>Send</button>
        </div>
        <div className="dock-footer"><span className="dock-hints">Routes to the owning feed · ⌘ Enter to send</span></div>
      </div>
    </div>
  );
}
