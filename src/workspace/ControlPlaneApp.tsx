import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, localRead, post } from "../app/api";
import type { CardAction, WorkspaceControlPlane, WorkspaceNowItem } from "../types";
import { RealtimeProvider, useRefreshCoalescer } from "../state/realtime";
import { flushVisibleCardEdits } from "../feed/cardEdits";
import { ControlPlaneNav } from "./ControlPlaneNav";
import { CoverageView } from "./CoverageView";
import { NowView } from "./NowView";
import { PriorityLedgerView } from "./PriorityLedgerView";
import { WorkspaceDock } from "./WorkspaceDock";
import { workspaceItemKey } from "./workspaceKeys";
import { workspaceContinuityFor } from "./continuityStore";

type NowSurface = Pick<WorkspaceControlPlane, "now" | "coverage">;
const WORKSPACE_SLICES = {
  "now-surface": {
    endpoint: "/api/workspace/now-surface",
    queryKey: ["workspace-control-plane", "now-surface"],
  },
  coverage: {
    endpoint: "/api/workspace/coverage",
    queryKey: ["workspace-control-plane", "coverage"],
  },
  priority: {
    endpoint: "/api/workspace/priority",
    queryKey: ["workspace-control-plane", "priority"],
  },
} as const;
type WorkspaceQuerySlice = keyof typeof WORKSPACE_SLICES;
type WorkspaceSlice = Exclude<WorkspaceQuerySlice, "coverage">;
type WorkspaceSliceData = NowSurface | WorkspaceControlPlane["priority"];
type ControlPlaneSurface = "now" | "coverage" | "ledger";
const SURFACE_SLICE: Record<ControlPlaneSurface, WorkspaceQuerySlice> = {
  now: "now-surface",
  coverage: "coverage",
  ledger: "priority",
};

type UncertainMutationStore = {
  getSnapshot(): ReadonlyMap<string, WorkspaceSlice>;
  subscribe(listener: () => void): () => void;
  update(mutationKey: string, slice: WorkspaceSlice | null): void;
};

const uncertaintyStores = new WeakMap<object, UncertainMutationStore>();

function uncertaintyStoreFor(owner: object): UncertainMutationStore {
  const existing = uncertaintyStores.get(owner);
  if (existing) return existing;
  let snapshot: ReadonlyMap<string, WorkspaceSlice> = new Map();
  const listeners = new Set<() => void>();
  const created: UncertainMutationStore = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(mutationKey, slice) {
      const changed = slice
        ? snapshot.get(mutationKey) !== slice
        : snapshot.has(mutationKey);
      if (!changed) return;
      const next = new Map(snapshot);
      if (slice) next.set(mutationKey, slice);
      else next.delete(mutationKey);
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
  uncertaintyStores.set(owner, created);
  return created;
}

function priorityMutationKey(proposalId: string): string {
  return `priority\u0000${proposalId}`;
}

export function ControlPlaneApp({ surface }: { surface: ControlPlaneSurface }) {
  const queryClient = useQueryClient();
  const continuityStore = useMemo(() => workspaceContinuityFor(queryClient), [queryClient]);
  const uncertaintyStore = useMemo(() => uncertaintyStoreFor(queryClient), [queryClient]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [pendingMutationKeys, setPendingMutationKeys] = useState<ReadonlySet<string>>(new Set());
  const [inspectionCount, setInspectionCount] = useState(0);
  const inspectionRequired = useSyncExternalStore(
    uncertaintyStore.subscribe,
    uncertaintyStore.getSnapshot,
  );
  const pendingMutationKeysRef = useRef(new Set<string>());
  const inspectionTailsRef = useRef(new Map<WorkspaceSlice, Promise<WorkspaceSliceData>>());
  const inspectionControllersRef = useRef(new Set<AbortController>());
  const toastTimer = useRef<number | null>(null);
  const nowSurfaceQuery = useQuery({
    queryKey: WORKSPACE_SLICES["now-surface"].queryKey,
    queryFn: ({ signal }) => localRead<NowSurface>(WORKSPACE_SLICES["now-surface"].endpoint, { signal }),
    enabled: surface === "now",
  });
  const coverageQuery = useQuery({
    queryKey: WORKSPACE_SLICES.coverage.queryKey,
    queryFn: ({ signal }) => localRead<WorkspaceControlPlane["coverage"]>(WORKSPACE_SLICES.coverage.endpoint, { signal }),
    enabled: surface === "coverage",
  });
  const priorityQuery = useQuery({
    queryKey: WORKSPACE_SLICES.priority.queryKey,
    queryFn: ({ signal }) => localRead<WorkspaceControlPlane["priority"]>(WORKSPACE_SLICES.priority.endpoint, { signal }),
    enabled: surface === "ledger",
  });
  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: WORKSPACE_SLICES[SURFACE_SLICE[surface]].queryKey });
  }, [queryClient, surface]);
  const cancelRefresh = useCallback(() => {
    return queryClient.cancelQueries({ queryKey: WORKSPACE_SLICES[SURFACE_SLICE[surface]].queryKey });
  }, [queryClient, surface]);
  const requestRefresh = useRefreshCoalescer(refresh, cancelRefresh);
  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2_600);
  }, []);
  const now = nowSurfaceQuery.data?.now;
  const coverage = surface === "now" ? nowSurfaceQuery.data?.coverage : coverageQuery.data;
  const priority = priorityQuery.data;
  const activeId = useMemo(() => {
    if (!now?.items.length) return null;
    return selectedId && now.items.some((item) => item.id === selectedId) ? selectedId : now.items[0].id;
  }, [now, selectedId]);
  const activeItem = now?.items.find((item) => item.id === activeId);
  const inspectCanonicalSlice = useCallback((slice: WorkspaceSlice): Promise<WorkspaceSliceData> => {
    const controller = new AbortController();
    inspectionControllersRef.current.add(controller);
    setInspectionCount((current) => current + 1);
    const prior = inspectionTailsRef.current.get(slice) ?? Promise.resolve(undefined);
    const inspection = prior.catch(() => undefined).then(async () => {
      if (slice === "priority") {
        const canonical = await localRead<WorkspaceControlPlane["priority"]>(
          WORKSPACE_SLICES.priority.endpoint,
          { signal: controller.signal },
        );
        queryClient.setQueryData(WORKSPACE_SLICES.priority.queryKey, canonical);
        return canonical;
      }
      const canonical = await localRead<NowSurface>(
        WORKSPACE_SLICES["now-surface"].endpoint,
        { signal: controller.signal },
      );
      queryClient.setQueryData(WORKSPACE_SLICES["now-surface"].queryKey, canonical);
      return canonical;
    }).finally(() => {
      inspectionControllersRef.current.delete(controller);
      setInspectionCount((current) => Math.max(0, current - 1));
    });
    inspectionTailsRef.current.set(slice, inspection);
    return inspection;
  }, [queryClient]);
  useEffect(() => () => {
    for (const controller of inspectionControllersRef.current) controller.abort();
  }, []);
  const finishPendingMutation = useCallback((mutationKey: string) => {
    pendingMutationKeysRef.current.delete(mutationKey);
    setPendingMutationKeys(new Set(pendingMutationKeysRef.current));
  }, []);
  const clearMutationLock = useCallback((mutationKey: string) => {
    uncertaintyStore.update(mutationKey, null);
  }, [uncertaintyStore]);
  const beginPendingMutation = useCallback((mutationKey: string): boolean => {
    if (
      pendingMutationKeysRef.current.has(mutationKey)
      || uncertaintyStore.getSnapshot().has(mutationKey)
    ) return false;
    pendingMutationKeysRef.current.add(mutationKey);
    setPendingMutationKeys(new Set(pendingMutationKeysRef.current));
    return true;
  }, [uncertaintyStore]);
  const retryMutationInspection = () => void (async () => {
    if (inspectionCount > 0) return;
    const entries = Array.from(uncertaintyStore.getSnapshot().entries());
    const slices = Array.from(new Set(entries.map(([, slice]) => slice)));
    try {
      await Promise.all(slices.map((slice) => inspectCanonicalSlice(slice)));
      for (const [mutationKey] of entries) clearMutationLock(mutationKey);
      showToast("Current card state verified");
    } catch (error) {
      showToast(`Still unable to verify action state: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();

  const executeMutation = useCallback(async ({
    mutationKey,
    slice,
    mutate,
    successMessage,
    verifyAmbiguous,
  }: {
    mutationKey: string;
    slice: WorkspaceSlice;
    mutate: () => Promise<unknown>;
    successMessage: string;
    verifyAmbiguous?: (canonical: WorkspaceSliceData) => boolean;
  }): Promise<boolean> => {
    if (!beginPendingMutation(mutationKey)) return false;
    let acknowledged = false;
    try {
      await mutate();
      acknowledged = true;
      await inspectCanonicalSlice(slice);
      clearMutationLock(mutationKey);
      showToast(successMessage);
      return true;
    } catch (error) {
      if (!acknowledged && error instanceof ApiError && error.status >= 400 && error.status < 500) {
        clearMutationLock(mutationKey);
        showToast(error.message);
        return false;
      }
      uncertaintyStore.update(mutationKey, slice);
      try {
        const canonical = await inspectCanonicalSlice(slice);
        const committed = acknowledged || Boolean(verifyAmbiguous?.(canonical));
        clearMutationLock(mutationKey);
        showToast(committed ? successMessage : "No change was recorded. Review the current state and try again.");
        return committed;
      } catch {
        showToast(acknowledged
          ? "Change submitted. Tend locked this control because the display refresh failed."
          : "Change result uncertain. Tend locked this control while it verifies the current state.");
        return acknowledged;
      }
    } finally {
      finishPendingMutation(mutationKey);
    }
  }, [beginPendingMutation, clearMutationLock, finishPendingMutation, inspectCanonicalSlice, showToast, uncertaintyStore]);

  const runAction = (item: WorkspaceNowItem, action: CardAction) => void (async () => {
    await executeMutation({
      mutationKey: workspaceItemKey(item),
      slice: "now-surface",
      mutate: async () => {
        await flushVisibleCardEdits(item.card, item.id);
        await post(`/api/feeds/${item.cardRef.feedId}/cards/${item.cardRef.cardId}/actions/${encodeURIComponent(action.id)}`);
      },
      successMessage: action.behavior === "dismiss_card" ? "Card dismissed" : `${action.label} queued for the owning feed`,
      verifyAmbiguous: (canonical) => {
        const current = (canonical as NowSurface).now.items.find((candidate) => candidate.id === item.id);
        if (!current) return true;
        if (action.behavior === "dismiss_card") {
          return current.card.status === "done" && current.card.completionDisposition === "dismissed";
        }
        return current.card.status !== "to_review_new" && current.card.status !== "to_review_updated";
      },
    });
  })();

  const returnToReview = (item: WorkspaceNowItem) => void (async () => {
    await executeMutation({
      mutationKey: workspaceItemKey(item),
      slice: "now-surface",
      mutate: () => post(`/api/feeds/${item.cardRef.feedId}/cards/${item.cardRef.cardId}/return-to-review`),
      successMessage: "Ready for review again",
      verifyAmbiguous: (canonical) => {
        const current = (canonical as NowSurface).now.items.find((candidate) => candidate.id === item.id);
        return Boolean(current && (
          current.card.status === "to_review_new" ||
          current.card.status === "to_review_updated"
        ));
      },
    });
  })();

  const instruct = async (instruction: string): Promise<boolean> => {
    if (!activeItem) return false;
    const item = activeItem;
    return executeMutation({
      mutationKey: workspaceItemKey(item),
      slice: "now-surface",
      mutate: () => post("/api/workspace/instructions", {
        cardRef: item.cardRef,
        instruction,
        ...(item.commitment ? { commitmentId: item.commitment.id, expectedCommitmentVersion: item.commitment.version } : {}),
      }),
      successMessage: `Queued for ${item.cardRef.feedId}`,
      verifyAmbiguous: (canonical) => {
        const current = (canonical as NowSurface).now.items.find((candidate) => candidate.id === item.id);
        if (!current || current.card.status === "queued") return true;
        return current.card.history.some((entry) =>
          entry.type === "user.scoped_instruction" && entry.detail === instruction.trim()
        );
      },
    });
  };

  const approveProposal = (proposalId: string) => void (async () => {
    await executeMutation({
      mutationKey: priorityMutationKey(proposalId),
      slice: "priority",
      mutate: () => post(`/api/workspace/priority/proposals/${proposalId}/approve`),
      successMessage: "Priority rule change approved",
      verifyAmbiguous: (canonical) => {
        const proposal = (canonical as WorkspaceControlPlane["priority"]).proposals
          .find((candidate) => candidate.id === proposalId);
        return !proposal || proposal.status !== "proposed";
      },
    });
  })();

  let activeData: NowSurface | WorkspaceControlPlane["coverage"] | WorkspaceControlPlane["priority"] | undefined = priorityQuery.data;
  let error = priorityQuery.error;
  let isFetching = priorityQuery.isFetching;
  if (surface === "now") {
    activeData = nowSurfaceQuery.data;
    error = nowSurfaceQuery.error;
    isFetching = nowSurfaceQuery.isFetching;
  } else if (surface === "coverage") {
    activeData = coverageQuery.data;
    error = coverageQuery.error;
    isFetching = coverageQuery.isFetching;
  }
  const stale = Boolean(error && activeData);
  let loading: boolean;
  if (surface === "now") loading = nowSurfaceQuery.isLoading || !now || !coverage;
  else if (surface === "coverage") loading = coverageQuery.isLoading || !coverage;
  else loading = priorityQuery.isLoading || !priority;
  return (
    <RealtimeProvider enabled onChange={requestRefresh}>
      {({ state: connectionState }) => {
        const mutationsDisabled = stale || connectionState !== "live" || inspectionRequired.size > 0;
        const busy = isFetching || inspectionCount > 0;
        const activeMutationKey = activeItem ? workspaceItemKey(activeItem) : null;
        return (
          <>
            <ControlPlaneNav active={surface} />
            {error && !activeData ? (
              <main className="control-page">
                <section className="control-empty is-blind">
                  <h1>Control plane unavailable</h1>
                  <p>{error instanceof Error ? error.message : String(error)}</p>
                  <button className="button ghost" onClick={() => void requestRefresh()}>Retry</button>
                </section>
              </main>
            ) : loading ? (
              <main className="loading" role="status" aria-live="polite" aria-busy="true">Loading your control plane…</main>
            ) : (
              <>
                {(stale || connectionState !== "live" || inspectionRequired.size > 0) && (
                  <div className="control-safety-banner" role={stale || inspectionRequired.size > 0 ? "alert" : "status"} aria-live="polite">
                    <span>
                      {inspectionRequired.size > 0
                        ? "A change result needs read-only verification before this control can be used again."
                        : stale
                          ? `Showing last-known state. Actions are paused until refresh succeeds.${error instanceof Error ? ` ${error.message}` : ""}`
                          : "Reconnecting to Tend. Actions are paused until the current state is synchronized."}
                    </span>
                    <button
                      className="button ghost"
                      disabled={busy}
                      onClick={inspectionRequired.size > 0 ? retryMutationInspection : () => void requestRefresh()}
                    >
                      {busy ? "Inspecting…" : "Refresh and inspect"}
                    </button>
                  </div>
                )}
                {surface === "now" && now && coverage ? (
                  <NowView control={{ now, coverage }} activeId={activeId} onActivate={(item) => setSelectedId(item.id)} onAction={runAction} onChanged={requestRefresh} onReturnToReview={returnToReview} pendingActionKeys={pendingMutationKeys} mutationsDisabled={mutationsDisabled} busy={busy} continuityStore={continuityStore} />
                ) : surface === "coverage" && coverage ? (
                  <CoverageView coverage={coverage} busy={busy} />
                ) : (
                  priority && <PriorityLedgerView priority={priority} onApprove={approveProposal} mutationsDisabled={mutationsDisabled} pendingProposalIds={new Set(priority.proposals.filter((proposal) => pendingMutationKeys.has(priorityMutationKey(proposal.id))).map((proposal) => proposal.id))} busy={busy} />
                )}
                {surface === "now" && <WorkspaceDock item={activeItem} onSubmit={instruct} disabled={mutationsDisabled || Boolean(activeMutationKey && pendingMutationKeys.has(activeMutationKey))} continuityStore={continuityStore} />}
              </>
            )}
            {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
          </>
        );
      }}
    </RealtimeProvider>
  );
}
