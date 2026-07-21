import type { SourceCoverage, WorkspaceCoverage } from "../types";

function label(state: SourceCoverage["state"]): string {
  const value = state.replaceAll("_", " ");
  return value[0]?.toUpperCase() + value.slice(1);
}

export function CoverageView({ coverage }: { coverage: WorkspaceCoverage }) {
  return (
    <main className="control-page" aria-labelledby="coverage-title">
      <header className="control-hero">
        <div><span className="panel-kicker">Visibility contract</span><h1 id="coverage-title">Coverage</h1><p>{coverage.caveat}</p></div>
        <div className={`coverage-total ${coverage.allClear ? "is-fresh" : "is-degraded"}`}>
          <b>{coverage.freshRequiredSources}/{coverage.requiredSources}</b><span>required sources fresh</span>
        </div>
      </header>
      {coverage.allClear && <div className="coverage-clear" role="status">All required sources are fresh and completeness-proven. Extraction can still be imperfect.</div>}
      <div className="coverage-grid">
        {coverage.sources.map((source) => (
          <article className={`coverage-card coverage-${source.state}`} key={source.id}>
            <header><div><span>{source.provider?.replaceAll("_", " ") ?? "Unconfigured"}</span><h2>{source.name}</h2></div><b>{label(source.state)}</b></header>
            <dl>
              <div><dt>Required</dt><dd>{source.required ? "Yes" : "No"}</dd></div>
              <div><dt>Last attempt</dt><dd>{source.lastAttemptAt ?? "Never"}</dd></div>
              <div><dt>Last good</dt><dd>{source.lastGoodAt ?? "None"}</dd></div>
              <div><dt>Age</dt><dd>{source.ageMinutes === null ? "Unknown" : `${source.ageMinutes} min`}</dd></div>
            </dl>
            <p>{source.detail}</p>
            {source.remediation && <div className="coverage-remediation"><span>Recovery</span><b>{source.remediation}</b></div>}
          </article>
        ))}
      </div>
      {coverage.sources.length === 0 && <section className="control-empty is-blind"><h2>No source portfolio is configured.</h2><p>Tend cannot certify an all-clear until required sources and exact identities are configured.</p></section>}
    </main>
  );
}
