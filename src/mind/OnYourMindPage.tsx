import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import type { MindContextHealth, MindContextObservation, MindContextSignal, MindContextSignalKind, MindContextUpdate, MindContextWorkspace, WorkspaceView } from "../../shared/types";
import { api } from "../app/api";
import { RealtimeProvider, useRefreshCoalescer } from "../state/realtime";
import { TopBar } from "../shell/TopBar";
import { DetachedLink } from "../ui/DetachedLink";
import { FormattedText } from "../ui/FormattedText";

const SIGNAL_GROUPS: Array<{ kind: MindContextSignalKind; label: string; description: string }> = [
  { kind: "changed_now", label: "Changed now", description: "What materially shifted in the latest observation window." },
  { kind: "ongoing", label: "Ongoing", description: "Active threads that continue to shape attention." },
  { kind: "unresolved", label: "Unresolved", description: "Questions or tensions that are still open." },
];

function formatDate(value?: string): string {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatObservationWindow(from?: string, to?: string): string {
  if (!from || !to) return "No observation window";
  const start = new Date(from);
  const end = new Date(to);
  const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(start);
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date}, ${time.format(start)}-${time.format(end)}`;
}

function healthLabel(health: MindContextHealth): string {
  if (health === "fresh") return "Fresh";
  if (health === "never_published") return "Not published yet";
  return health[0].toUpperCase() + health.slice(1);
}

function FocusMark() {
  return (
    <svg aria-hidden="true" className="mind-focus-mark" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    </svg>
  );
}

export function MindRefreshStatus({
  error,
  busy,
  onRetry,
}: {
  error?: unknown;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="control-safety-banner" role={error ? "alert" : "status"} aria-live="polite">
      <span>
        {error
          ? `Showing last-known context because refresh failed: ${error instanceof Error ? error.message : String(error)}`
          : "Showing last-known context while Tend reconnects."}
      </span>
      <button className="button ghost" disabled={busy} onClick={onRetry}>
        {busy ? "Refreshing…" : "Retry"}
      </button>
    </div>
  );
}

function Observation({ observation }: { observation: MindContextObservation }) {
  const sourceMeta = [observation.app, observation.artifact, formatObservationWindow(observation.observedFrom, observation.observedTo)]
    .filter(Boolean)
    .join(" · ");
  return (
    <article className="mind-observation">
      <header>
        <div>
          <b>{observation.title}</b>
          <span>{sourceMeta}</span>
        </div>
        {observation.href && <DetachedLink href={observation.href}>Open source</DetachedLink>}
      </header>
      <p><FormattedText text={observation.excerpt} /></p>
      {observation.fullText && (
        <details>
          <summary>Full filtered window</summary>
          <pre>{observation.fullText}</pre>
        </details>
      )}
      {Boolean(observation.redactionCount) && (
        <small>{observation.redactionCount} {observation.redactionCount === 1 ? "redaction" : "redactions"}</small>
      )}
    </article>
  );
}

function SignalSection({
  signal,
  observationById,
}: {
  signal: MindContextSignal;
  observationById: Map<string, MindContextObservation>;
}) {
  const [expanded, setExpanded] = useState(false);
  const observations = signal.observationIds.flatMap((id) => {
    const observation = observationById.get(id);
    return observation ? [observation] : [];
  });
  const visible = expanded ? observations : observations.slice(0, 3);
  const hiddenCount = observations.length - visible.length;

  return (
    <article className="mind-signal" id={`signal-${signal.id}`}>
      <header>
        <FocusMark />
        <div>
          <h2>{signal.title}</h2>
          <p>{signal.summary}</p>
        </div>
      </header>
      <div className="mind-source-heading">
        <span>Source trail</span>
        <small>{visible.length < observations.length ? `${visible.length} of ${observations.length}` : observations.length}</small>
      </div>
      <div className="mind-observations">
        {visible.map((observation) => <Observation key={observation.id} observation={observation} />)}
      </div>
      {observations.length > 3 && (
        <button className="mind-source-toggle" type="button" onClick={() => setExpanded((value) => !value)}>
          {expanded
            ? "Show fewer source observations"
            : `Show ${hiddenCount} more ${hiddenCount === 1 ? "source observation" : "source observations"}`}
        </button>
      )}
    </article>
  );
}

export function OnYourMindContent({
  workspace,
  historical = false,
  busy = false,
}: {
  workspace: MindContextWorkspace;
  historical?: boolean;
  busy?: boolean;
}) {
  const selected = workspace.current;
  const current = selected?.state === "fresh" ? selected : null;
  const historicalHealth = historical && selected?.state !== "fresh" ? selected : null;
  const observationById = new Map(current?.observations?.map((observation) => [observation.id, observation]) ?? []);
  const sourceCount = current?.observations?.length ?? 0;

  return (
    <main className="mind-page" aria-busy={busy}>
      <header className="mind-hero">
        <div className="mind-kicker">
          <span className={`mind-health ${historical ? "mind-health-historical" : `mind-health-${workspace.health}`}`}>
            {historicalHealth ? "Historical health update" : historical ? "Historical pulse" : healthLabel(workspace.health)}
          </span>
          {current && <span>Observed {formatObservationWindow(current.observedFrom, current.observedTo)}</span>}
          {current && <span>{sourceCount} {sourceCount === 1 ? "source observation" : "source observations"}</span>}
        </div>
        <div className="mind-title-row">
          <FocusMark />
          <h1>On Your Mind</h1>
        </div>
        {current
          ? <p className="mind-synthesis">{current.summary}</p>
          : historicalHealth
            ? (
                <div className="mind-state-message">
                  <h2>Context was marked {historicalHealth.state}.</h2>
                  <p>{historicalHealth.reason ?? "No reliable observation window was available for this publication."}</p>
                  <small>Published {formatDate(historicalHealth.publishedAt)}</small>
                </div>
              )
          : (
              <div className="mind-state-message">
                <h2>{workspace.health === "never_published" ? "Waiting for the first Chronicle pulse." : "Current context is not usable by feeds."}</h2>
                <p>
                  {workspace.health === "unavailable"
                    ? "Chronicle could not produce a reliable current window. Feeds continue normally without contextual influence."
                    : workspace.health === "stale"
                      ? "The last reliable pulse has expired. Feeds continue normally until Chronicle publishes a fresh update."
                      : "Bind the Chronicle Pulse thread and publish a fresh privacy-filtered update."}
                </p>
              </div>
            )}
        {current && (
          <div className="mind-freshness">
            <span>Published {formatDate(current.publishedAt)}</span>
            <span>{historical ? "Originally fresh until" : "Fresh until"} {formatDate(current.freshUntil)}</span>
          </div>
        )}
      </header>

      {current && SIGNAL_GROUPS.map((group) => {
        const signals = current.signals?.filter((signal) => signal.kind === group.kind) ?? [];
        if (!signals.length) return null;
        return (
          <section className="mind-group" key={group.kind}>
            <header className="mind-group-head">
              <div>
                <span className="panel-kicker">{group.label}</span>
                <p>{group.description}</p>
              </div>
              <span>{signals.length}</span>
            </header>
            {signals.map((signal) => <SignalSection key={signal.id} signal={signal} observationById={observationById} />)}
          </section>
        );
      })}

      <section className="mind-history">
        <header>
          <div>
            <span className="panel-kicker">Recent pulse history</span>
            <p>Recent publications, plus older pulses still referenced by cards.</p>
          </div>
        </header>
        {workspace.history.length ? (
          <ol>
            {workspace.history.map((item) => (
              <li key={item.id}>
                <span className={`mind-history-state mind-health-${item.state}`}>{healthLabel(item.state)}</span>
                {item.state === "fresh"
                  ? (
                      <a className="mind-history-link" href={`/mind/${encodeURIComponent(item.id)}`}>
                        <b>{item.summary ?? "Context pulse"}</b>
                        <small>{formatDate(item.publishedAt)} · {item.signalCount} signals · {item.sourceCount} sources</small>
                      </a>
                    )
                  : (
                      <div className="mind-history-copy">
                        <b>{item.reason ?? "Context health update"}</b>
                        <small>{formatDate(item.publishedAt)}</small>
                      </div>
                    )}
              </li>
            ))}
          </ol>
        ) : <p className="mind-history-empty">No Chronicle pulse has been published yet.</p>}
      </section>
    </main>
  );
}

export function OnYourMindPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { updateId } = useParams({ strict: false }) as { updateId?: string };
  const locationHash = useLocation({ select: (location) => location.hash });
  const workspaceQuery = useQuery({
    queryKey: ["workspace", "mind-navigation"],
    queryFn: ({ signal }) => api<WorkspaceView>("/api/state?feed=inbox", { signal }),
  });
  const mindQuery = useQuery({
    queryKey: ["mind-context"],
    queryFn: ({ signal }) => api<MindContextWorkspace>("/api/mind-context/current", { signal }),
  });
  const selectedUpdateQuery = useQuery({
    queryKey: ["mind-context", "update", updateId],
    queryFn: ({ signal }) => api<MindContextUpdate>(`/api/mind-context/${encodeURIComponent(updateId ?? "")}`, { signal }),
    enabled: Boolean(updateId),
  });
  const refreshQueries = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["workspace"] }),
      queryClient.invalidateQueries({ queryKey: ["mind-context"] }),
    ]);
  }, [queryClient]);
  const cancelRefreshQueries = useCallback(async () => {
    await Promise.all([
      queryClient.cancelQueries({ queryKey: ["workspace"] }),
      queryClient.cancelQueries({ queryKey: ["mind-context"] }),
    ]);
  }, [queryClient]);
  const refresh = useRefreshCoalescer(refreshQueries, cancelRefreshQueries);

  useEffect(() => {
    const encodedTargetId = (locationHash || window.location.hash).replace(/^#/, "");
    const targetId = decodeURIComponent(encodedTargetId);
    if ((!mindQuery.data && !selectedUpdateQuery.data) || !targetId) return;
    const scrollToSignal = () => {
      document.getElementById(targetId)?.scrollIntoView({ block: "start" });
    };
    const frame = window.requestAnimationFrame(scrollToSignal);
    const timer = window.setTimeout(scrollToSignal, 100);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [locationHash, mindQuery.data, selectedUpdateQuery.data]);

  return (
    <RealtimeProvider enabled onChange={refresh}>
      {({ state: connectionState }) => {
        const unavailable = (workspaceQuery.isError && !workspaceQuery.data) || (mindQuery.isError && !mindQuery.data);
        if (unavailable) {
          const loadError = workspaceQuery.error ?? mindQuery.error;
          return (
            <main className="mind-page">
              <div className="mind-state-message" role="alert">
                <h1>On Your Mind could not be loaded.</h1>
                <p>{loadError instanceof Error ? loadError.message : "Feeds continue normally without contextual influence."}</p>
                <button className="button ghost" disabled={workspaceQuery.isFetching || mindQuery.isFetching} onClick={() => void refresh()}>Retry</button>
              </div>
            </main>
          );
        }
        if (!workspaceQuery.data || !mindQuery.data || (updateId && selectedUpdateQuery.isPending)) {
          return <main className="loading" role="status" aria-live="polite" aria-busy="true">Loading context...</main>;
        }
        const workspace = updateId && selectedUpdateQuery.data
          ? { ...mindQuery.data, current: selectedUpdateQuery.data }
          : mindQuery.data;
        const queryError = workspaceQuery.error ?? mindQuery.error ?? (updateId ? selectedUpdateQuery.error : null);
        const stale = Boolean(queryError) || connectionState !== "live";
        const busy = workspaceQuery.isFetching || mindQuery.isFetching || selectedUpdateQuery.isFetching;
        return (
          <>
            <TopBar
              state={workspaceQuery.data}
              title="On Your Mind"
              destination="mind"
              onMind={() => void navigate({ to: "/mind" })}
              onFeed={(feedId) => void navigate({ to: "/feed/$feedId", params: { feedId } })}
            />
            {stale && (
              <MindRefreshStatus error={queryError} busy={busy} onRetry={() => void refresh()} />
            )}
            {updateId && selectedUpdateQuery.isError
              ? (
                  <main className="mind-page">
                    <div className="mind-state-message" role="alert">
                      <h1>That pulse is no longer available.</h1>
                      <p>{selectedUpdateQuery.error instanceof Error ? selectedUpdateQuery.error.message : "The card still records that context influenced it, but its detailed source trail could not be loaded."}</p>
                      <button className="button ghost" disabled={selectedUpdateQuery.isFetching} onClick={() => void selectedUpdateQuery.refetch()}>
                        {selectedUpdateQuery.isFetching ? "Retrying…" : "Retry pulse"}
                      </button>
                    </div>
                  </main>
                )
              : <OnYourMindContent workspace={workspace} historical={Boolean(updateId)} busy={busy} />}
          </>
        );
      }}
    </RealtimeProvider>
  );
}
