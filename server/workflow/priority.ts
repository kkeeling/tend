import type { PriorityRuleSet, WorkspaceCommitment, WorkspaceNowRow } from "../../shared/types";
import { digest } from "../util";

const consequenceScore = { low: 0, medium: 100, high: 250, severe: 500 } as const;
const DOMAIN_TIER_SCORE = 10_000;
export const DEFAULT_PRIORITY_JUDGMENT_POLICY_VERSION = "priority-v1";

function dueBand(dueAt: string | undefined, now: Date): { label: string; score: number; minutes: number | null } {
  if (!dueAt) return { label: "no due date", score: 0, minutes: null };
  const minutes = Math.floor((Date.parse(dueAt) - now.getTime()) / 60_000);
  if (minutes <= 0) return { label: "overdue", score: 1_000, minutes };
  if (minutes <= 60) return { label: "due within an hour", score: 900, minutes };
  if (minutes <= 24 * 60) return { label: "due within a day", score: 600, minutes };
  if (minutes <= 7 * 24 * 60) return { label: "due within a week", score: 300, minutes };
  return { label: "due later", score: 100, minutes };
}

export function evaluatePriorityRows(
  commitments: WorkspaceCommitment[],
  ruleSet: PriorityRuleSet,
  judgmentPolicyVersion: string,
  now: Date,
): WorkspaceNowRow[] {
  const active = commitments.filter((item) => !["fulfilled", "withdrawn", "superseded"].includes(item.status));
  const drafts = active.map((commitment) => {
    const domainIndex = ruleSet.rules.domainOrder.indexOf(commitment.priorityContext.domain);
    const due = dueBand(commitment.dueAt, now);
    const consequence = consequenceScore[commitment.priorityContext.consequence];
    const certainty = Math.round(commitment.certainty * 100);
    const blocked = commitment.priorityContext.blocked ? -150 : 0;
    const lowerDomain = domainIndex > 0;
    const imminent = due.minutes !== null && due.minutes <= ruleSet.rules.imminentWithinMinutes;
    const highConsequence = commitment.priorityContext.consequence === "high" || commitment.priorityContext.consequence === "severe";
    const overrideEligible = ruleSet.rules.severeConsequenceOverride && lowerDomain && (imminent || highConsequence);
    const normalDomainTier = domainIndex < 0 ? 0 : ruleSet.rules.domainOrder.length - domainIndex;
    const effectiveDomainTier = overrideEligible ? ruleSet.rules.domainOrder.length : normalDomainTier;
    const domainScore = effectiveDomainTier * DOMAIN_TIER_SCORE;
    const score = domainScore + due.score + consequence + certainty + blocked;
    const explanation = `${commitment.priorityContext.domain} contributes domain tier ${normalDomainTier}; ${due.label} contributes ${due.score}; ${commitment.priorityContext.consequence} consequence contributes ${consequence}; certainty contributes ${certainty}${blocked ? "; blocked state subtracts 150" : ""}.`;
    return { commitment, domainIndex, score, explanation, overrideEligible, imminent, highConsequence, dueBand: due.label };
  }).sort((left, right) => right.score - left.score
    || (left.commitment.dueAt ?? "9999").localeCompare(right.commitment.dueAt ?? "9999")
    || left.commitment.id.localeCompare(right.commitment.id));

  return drafts.map((draft, index) => {
    const rank = index + 1;
    const overridesHigherDomain = draft.overrideEligible && drafts.slice(index + 1).some((other) =>
      other.domainIndex >= 0 && other.domainIndex < draft.domainIndex,
    );
    const overrideReason = overridesHigherDomain
      ? `Lower-domain work overrides the normal domain order because ${[
          draft.imminent ? `it is imminent (${draft.dueBand})` : "",
          draft.highConsequence ? `it has ${draft.commitment.priorityContext.consequence} consequence` : "",
        ].filter(Boolean).join(" and ")}.`
      : undefined;
    const inputDigest = digest({
      commitmentId: draft.commitment.id,
      commitmentVersion: draft.commitment.version,
      priorityContext: draft.commitment.priorityContext,
      dueAt: draft.commitment.dueAt,
      certainty: draft.commitment.certainty,
      dueBand: draft.dueBand,
      ruleSetId: ruleSet.id,
      ruleVersion: ruleSet.version,
      judgmentPolicyVersion,
      rank,
      score: draft.score,
      overrideReason: overrideReason ?? null,
    });
    return {
      id: `${draft.commitment.owner.feedId}:${draft.commitment.owner.cardId}`,
      cardRef: draft.commitment.owner,
      commitmentId: draft.commitment.id,
      rank,
      score: draft.score,
      explanation: draft.explanation,
      ...(overrideReason ? { overrideReason } : {}),
      ruleSetId: ruleSet.id,
      ruleVersion: ruleSet.version,
      judgmentPolicyVersion,
      inputDigest,
      evaluatedAt: now.toISOString(),
    };
  });
}
