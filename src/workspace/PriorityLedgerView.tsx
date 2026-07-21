import type { WorkspaceControlPlane } from "../types";

export function PriorityLedgerView({
  priority,
  onApprove,
}: {
  priority: WorkspaceControlPlane["priority"];
  onApprove: (proposalId: string) => void;
}) {
  return (
    <main className="control-page" aria-labelledby="ledger-title">
      <header className="control-hero">
        <div><span className="panel-kicker">Append-only decisions</span><h1 id="ledger-title">Priority Ledger</h1><p>Every material ordering, correction, override, and rule approval remains traceable.</p></div>
        <div className="rule-version"><span>Active rules</span><b>{priority.activeRules ? `v${priority.activeRules.version}` : "Not configured"}</b></div>
      </header>
      {priority.proposals.filter((proposal) => proposal.status === "proposed").map((proposal) => (
        <article className="rule-proposal" key={proposal.id}>
          <span>Rule change proposed from v{proposal.baseVersion}</span><h2>{proposal.reason}</h2>
          <p>No future ordering changes until this exact proposal is approved.</p>
          <button className="button primary" onClick={() => onApprove(proposal.id)}>Approve exact rule change</button>
        </article>
      ))}
      <ol className="ledger-list">
        {[...priority.ledger].reverse().map((entry) => {
          const explanation = typeof entry.detail.explanation === "string" ? entry.detail.explanation : typeof entry.detail.reason === "string" ? entry.detail.reason : JSON.stringify(entry.detail);
          return (
            <li key={entry.id}>
              <div className={`ledger-dot ledger-${entry.type}`} aria-hidden="true" />
              <article><header><b>{entry.type.replaceAll("_", " ")}</b><time dateTime={entry.at}>{entry.at}</time></header><p>{explanation}</p><small>{entry.ruleVersion ? `Rule v${entry.ruleVersion}` : "Rule version not applicable"}{entry.commitmentId ? ` · ${entry.commitmentId}` : ""}</small></article>
            </li>
          );
        })}
      </ol>
      {priority.ledger.length === 0 && <section className="control-empty"><h2>No priority decisions yet.</h2><p>Approved rules and material evaluations will appear here.</p></section>}
    </main>
  );
}
