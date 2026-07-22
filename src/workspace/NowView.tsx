import type { CardAction, WorkspaceControlPlane, WorkspaceNowItem } from "../types";
import { CardView } from "../feed/CardView";

export function NowView({
  control,
  activeId,
  onActivate,
  onAction,
  onChanged,
  onReturnToReview,
}: {
  control: WorkspaceControlPlane;
  activeId: string | null;
  onActivate: (item: WorkspaceNowItem) => void;
  onAction: (item: WorkspaceNowItem, action: CardAction) => void;
  onChanged: () => void;
  onReturnToReview: (item: WorkspaceNowItem) => void;
}) {
  return (
    <main className="control-page now-page" aria-labelledby="now-title">
      <header className="control-hero">
        <div>
          <span className="panel-kicker">Life control plane</span>
          <h1 id="now-title">What needs you now</h1>
          <p>{control.now.message}</p>
        </div>
        <a className={`coverage-summary ${control.coverage.allClear ? "is-fresh" : "is-degraded"}`} href="/coverage">
          <b>{control.coverage.freshRequiredSources}/{control.coverage.requiredSources} required sources fresh</b>
          <span>{control.coverage.allClear ? "Coverage complete" : control.coverage.caveat}</span>
        </a>
      </header>
      {control.now.items.length === 0 ? (
        <section className={`control-empty ${control.now.allClear ? "is-clear" : "is-blind"}`}>
          <h2>{control.now.allClear ? "Everything visible is handled." : "No cards are visible, but coverage is incomplete."}</h2>
          <p>{control.now.allClear ? control.coverage.caveat : `Tend will not call this an all-clear. ${control.coverage.caveat}`}</p>
        </section>
      ) : (
        <div className="now-stack">
          {control.now.items.map((item) => (
            <section className="workspace-now-item" key={item.id} aria-label={`Priority ${item.priority.rank}: ${item.card.title}`}>
              <div className="priority-explanation">
                <span>#{item.priority.rank}</span>
                <div>
                  <b>{item.priority.overrideReason ? "Priority override" : "Why this is here"}</b>
                  <p>{item.priority.overrideReason ?? item.priority.explanation}</p>
                  <small>Owner: {item.cardRef.feedId}{item.priority.ruleVersion ? ` · rule v${item.priority.ruleVersion}` : " · existing attention card"}</small>
                </div>
              </div>
              {item.commitment && (
                <div className="commitment-strip">
                  <span>{item.commitment.status.replaceAll("_", " ")}</span>
                  <b>{item.commitment.signals.length} source receipt{item.commitment.signals.length === 1 ? "" : "s"}</b>
                  {item.commitment.dueAt && <time dateTime={item.commitment.dueAt}>Due {new Date(item.commitment.dueAt).toLocaleString()}</time>}
                  <details className="commitment-provenance">
                    <summary>Inspect provenance</summary>
                    <ul>{item.commitment.signals.map((signal) => (
                      <li key={signal.id}>
                        <b>{signal.kind.replaceAll("_", " ")}</b>
                        <span>{signal.feedId} / {signal.sourceId}</span>
                        <time dateTime={signal.observedAt}>{new Date(signal.observedAt).toLocaleString()}</time>
                      </li>
                    ))}</ul>
                  </details>
                </div>
              )}
              <CardView
                card={item.card}
                domId={item.id}
                active={item.id === activeId}
                onActivate={() => onActivate(item)}
                onChanged={onChanged}
                onAction={(action) => onAction(item, action)}
                onReturnToReview={() => onReturnToReview(item)}
              />
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
