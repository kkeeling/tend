import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, post } from "../app/api";
import type { CardAction, WorkspaceControlPlane, WorkspaceNowItem } from "../types";
import { RealtimeProvider } from "../state/realtime";
import { ControlPlaneNav } from "./ControlPlaneNav";
import { CoverageView } from "./CoverageView";
import { NowView } from "./NowView";
import { PriorityLedgerView } from "./PriorityLedgerView";
import { WorkspaceDock } from "./WorkspaceDock";

export function ControlPlaneApp({ surface }: { surface: "now" | "coverage" | "ledger" }) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | null>(null);
  const query = useQuery({ queryKey: ["workspace-control-plane"], queryFn: () => api<WorkspaceControlPlane>("/api/workspace") });
  const refresh = useCallback(async () => { await queryClient.invalidateQueries({ queryKey: ["workspace-control-plane"] }); }, [queryClient]);
  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2_600);
  }, []);
  const control = query.data;
  const activeId = useMemo(() => {
    if (!control?.now.items.length) return null;
    return selectedId && control.now.items.some((item) => item.id === selectedId) ? selectedId : control.now.items[0].id;
  }, [control, selectedId]);
  const activeItem = control?.now.items.find((item) => item.id === activeId);

  const flushEdits = async (item: WorkspaceNowItem) => {
    const selector = `[data-card-id="${CSS.escape(item.id)}"] textarea[data-block-id]`;
    const textareas = document.querySelectorAll<HTMLTextAreaElement>(selector);
    await Promise.all(Array.from(textareas).map(async (textarea) => {
      const block = item.card.blocks.find((candidate) => candidate.id === textarea.dataset.blockId);
      if (!block || block.type !== "editable_text" || textarea.value === (block.value ?? "")) return;
      await post(`/api/feeds/${item.cardRef.feedId}/cards/${item.cardRef.cardId}/blocks/${block.id}`, { value: textarea.value });
    }));
  };

  const runAction = (item: WorkspaceNowItem, action: CardAction) => void (async () => {
    try {
      await flushEdits(item);
      await post(`/api/feeds/${item.cardRef.feedId}/cards/${item.cardRef.cardId}/actions/${encodeURIComponent(action.id)}`);
      showToast(action.behavior === "dismiss_card" ? "Card dismissed" : `${action.label} queued for the owning feed`);
      await refresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  })();

  const returnToReview = (item: WorkspaceNowItem) => void (async () => {
    try {
      await post(`/api/feeds/${item.cardRef.feedId}/cards/${item.cardRef.cardId}/return-to-review`);
      showToast("Ready for review again");
      await refresh();
    } catch (error) { showToast(error instanceof Error ? error.message : String(error)); }
  })();

  const instruct = (instruction: string) => {
    if (!activeItem) return;
    void (async () => {
      try {
        await post("/api/workspace/instructions", {
          cardRef: activeItem.cardRef,
          instruction,
          ...(activeItem.commitment ? { commitmentId: activeItem.commitment.id, expectedCommitmentVersion: activeItem.commitment.version } : {}),
        });
        showToast(`Queued for ${activeItem.cardRef.feedId}`);
        await refresh();
      } catch (error) { showToast(error instanceof Error ? error.message : String(error)); }
    })();
  };

  const approveProposal = (proposalId: string) => void (async () => {
    try {
      await post(`/api/workspace/priority/proposals/${proposalId}/approve`);
      showToast("Priority rule change approved");
      await refresh();
    } catch (error) { showToast(error instanceof Error ? error.message : String(error)); }
  })();

  if (query.error) return <><ControlPlaneNav active={surface} /><main className="control-page"><section className="control-empty is-blind"><h1>Control plane unavailable</h1><p>{query.error instanceof Error ? query.error.message : String(query.error)}</p></section></main></>;
  if (query.isLoading || !control) return <><ControlPlaneNav active={surface} /><main className="loading">Loading your control plane…</main></>;

  return (
    <RealtimeProvider enabled onChange={() => void refresh()}>
      <ControlPlaneNav active={surface} />
      {surface === "now" ? (
        <NowView control={control} activeId={activeId} onActivate={(item) => setSelectedId(item.id)} onAction={runAction} onChanged={() => void refresh()} onReturnToReview={returnToReview} />
      ) : surface === "coverage" ? (
        <CoverageView coverage={control.coverage} />
      ) : (
        <PriorityLedgerView priority={control.priority} onApprove={approveProposal} />
      )}
      {surface === "now" && <WorkspaceDock item={activeItem} onSubmit={instruct} />}
      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    </RealtimeProvider>
  );
}
