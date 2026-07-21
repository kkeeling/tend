import type {
  SourceAttempt,
  SourceAttemptCompleteness,
  SourceCoverage,
  SourceCoverageState,
  SourceRecipe,
  WorkspaceCoverage,
} from "../../shared/types";
import { sourceIdentityMatches } from "./connectors";

export interface CoverageSource {
  feedId: string;
  recipe: SourceRecipe;
}

function isComplete(value: SourceAttemptCompleteness | undefined): boolean {
  return Boolean(
    value?.identityVerified
    && value.scopeVerified
    && value.permissionsComplete
    && value.paginationComplete
    && value.backfillComplete,
  );
}

function completedAtSort(left: SourceAttempt, right: SourceAttempt): number {
  return left.completedAt.localeCompare(right.completedAt) || left.id.localeCompare(right.id);
}

function stateForOutcome(outcome: SourceAttempt["outcome"]): SourceCoverageState {
  switch (outcome) {
    case "success":
    case "no_change":
      return "fresh";
    case "partial":
      return "partial";
    case "rate_limited":
      return "rate_limited";
    case "permission_denied":
      return "permission_denied";
    case "identity_mismatch":
      return "identity_mismatch";
    case "authorization_required":
      return "authorization_required";
    case "paused":
      return "paused";
    case "connector_unavailable":
    case "transient_error":
    case "disconnected":
      return "disconnected";
  }
}

function remediationFor(state: SourceCoverageState): string | null {
  switch (state) {
    case "not_configured": return "Configure the source profile and expected identity.";
    case "authorization_required": return "Authorize the connector, then verify identity and run a bounded collection.";
    case "connected_not_collected": return "Run the first bounded collection and prove pagination, scope, and permissions.";
    case "partial": return "Complete pagination or backfill before treating this source as covered.";
    case "stale": return "Refresh this source through its configured freshness boundary.";
    case "rate_limited": return "Retry after the provider rate limit resets; the last good data remains visible.";
    case "permission_denied": return "Grant the required read permission, then repeat a bounded collection.";
    case "identity_mismatch": return "Reconnect the exact expected identity before collecting or acting.";
    case "paused": return "Resume the source and complete a fresh bounded collection.";
    case "disconnected": return "Reconnect the source and verify identity before retrying collection.";
    case "fresh": return null;
  }
}

function detailFor(state: SourceCoverageState, last: SourceAttempt | undefined): string {
  if (last?.error?.message) return last.error.message;
  switch (state) {
    case "fresh": return "Identity, configured scope, permissions, backfill, and pagination are complete.";
    case "stale": return "The last complete collection is older than this source's freshness window.";
    case "connected_not_collected": return "The profile is connected but has no complete collection receipt.";
    default: return remediationFor(state) ?? "Coverage is available.";
  }
}

export function projectCoverage(
  sources: CoverageSource[],
  attempts: SourceAttempt[],
  now = new Date(),
): WorkspaceCoverage {
  const attemptsBySource = new Map<string, SourceAttempt[]>();
  for (const attempt of attempts) {
    const key = `${attempt.feedId}\u0000${attempt.sourceId}`;
    const sourceAttempts = attemptsBySource.get(key) ?? [];
    sourceAttempts.push(attempt);
    attemptsBySource.set(key, sourceAttempts);
  }
  for (const sourceAttempts of attemptsBySource.values()) sourceAttempts.sort(completedAtSort);

  const projected = sources.map(({ feedId, recipe }): SourceCoverage => {
    const profile = recipe.profile;
    const sourceAttempts = attemptsBySource.get(`${feedId}\u0000${recipe.id}`) ?? [];
    const last = sourceAttempts.at(-1);
    const lastGood = sourceAttempts.filter((attempt) =>
      (attempt.outcome === "success" || attempt.outcome === "no_change")
      && attempt.checkpointAdvanced
      && Boolean(attempt.observedIdentity)
      && sourceIdentityMatches(profile?.expectedIdentity ?? {}, attempt.observedIdentity!)
      && isComplete(attempt.completeness),
    ).at(-1);

    let state: SourceCoverageState;
    if (!profile) state = "not_configured";
    else if (profile.onboardingState === "authorization_required") state = "authorization_required";
    else if (profile.onboardingState === "paused") state = "paused";
    else if (profile.onboardingState === "disconnected") state = "disconnected";
    else if (!last) state = "connected_not_collected";
    else {
      state = stateForOutcome(last.outcome);
      if (
        (state === "fresh")
        && (!last.checkpointAdvanced || !last.observedIdentity || !sourceIdentityMatches(profile.expectedIdentity, last.observedIdentity) || !isComplete(last.completeness))
      ) state = "partial";
      if (state === "fresh" && lastGood) {
        const age = (now.getTime() - Date.parse(lastGood.completedAt)) / 60_000;
        if (!Number.isFinite(age) || age > profile.freshnessMinutes) state = "stale";
      }
    }

    const ageMinutes = lastGood
      ? Math.max(0, Math.floor((now.getTime() - Date.parse(lastGood.completedAt)) / 60_000))
      : null;
    return {
      id: `${feedId}:${recipe.id}`,
      feedId,
      sourceId: recipe.id,
      name: recipe.name,
      provider: profile?.provider ?? null,
      expectedIdentity: profile?.expectedIdentity ?? null,
      observedIdentity: last?.observedIdentity ?? null,
      required: profile?.required ?? false,
      state,
      allClearEligible: state === "fresh",
      lastAttemptAt: last?.completedAt ?? null,
      lastGoodAt: lastGood?.completedAt ?? null,
      ageMinutes,
      remediation: remediationFor(state),
      detail: detailFor(state, last),
    };
  }).sort((left, right) => Number(right.required) - Number(left.required) || left.name.localeCompare(right.name));

  const required = projected.filter((source) => source.required);
  const freshRequired = required.filter((source) => source.allClearEligible);
  const allClear = required.length > 0 && required.length === freshRequired.length;
  return {
    asOf: now.toISOString(),
    allClear,
    requiredSources: required.length,
    freshRequiredSources: freshRequired.length,
    caveat: allClear
      ? "All configured required sources prove identity, scope, completeness, and freshness. Language extraction can still be imperfect."
      : required.length === 0
        ? "No required source portfolio is configured, so Tend cannot certify an all-clear."
        : `${required.length - freshRequired.length} required source${required.length - freshRequired.length === 1 ? " is" : "s are"} not coverage-complete.`,
    sources: projected,
  };
}
