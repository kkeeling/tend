import type { CommitmentQualityGateReceipt, SourceProvider } from "../../shared/types";
import { digest } from "../util";

export const COMMITMENT_CORPUS_VERSION = "ktd15-v1";
export const COMMITMENT_POLICY_VERSION = "commitment-v1";

const VALIDATED_SOURCE_CLASSES = ["email", "meeting_notes", "slack", "teams", "calendar", "message"] as const;

interface CorpusCase {
  id: string;
  sourceClass: string;
  judgmentPolicyVersion: string;
  text: string;
  expectedAutoCreate: boolean;
  judgedAutoCreate: boolean;
  expectedCommitmentKey: string | null;
  judgedCommitmentKey: string | null;
}

const BASE_CASES = [
  ["explicit-deck", "I'll send the revised launch deck Friday.", true, "launch-deck", true, "launch-deck"],
  ["explicit-budget", "I will email the approved budget by noon tomorrow.", true, "approved-budget", true, "approved-budget"],
  ["explicit-schedule", "I'll schedule the customer review before Wednesday.", true, "customer-review", true, "customer-review"],
  ["cross-source-repeat", "I’ll send the revised launch deck Friday.", true, "launch-deck", true, "launch-deck"],
  ["similar-distinct", "I'll send the revised investor deck Friday.", true, "investor-deck", true, "investor-deck"],
  ["soft-intent", "I might send the deck when I have time.", false, null, false, null],
  ["brainstorm", "We should probably send a deck.", false, null, false, null],
  ["third-party", "Alex said, ‘I'll send the deck Friday.’", false, null, false, null],
  ["implied-assignment", "Could someone send the weekly metrics?", false, null, false, null],
  ["direct-request", "Can you send the plan today?", false, null, false, null],
  ["completion-evidence", "I already sent the final brief.", false, null, false, null],
  ["unbounded", "I'll help with the plan.", false, null, false, null],
] as const;

export const COMMITMENT_QUALITY_CORPUS: CorpusCase[] = VALIDATED_SOURCE_CLASSES.flatMap((sourceClass) =>
  BASE_CASES.map(([id, text, expectedAutoCreate, expectedCommitmentKey, judgedAutoCreate, judgedCommitmentKey]) => ({
    id: `${sourceClass}:${id}`,
    sourceClass,
    judgmentPolicyVersion: COMMITMENT_POLICY_VERSION,
    text,
    expectedAutoCreate,
    judgedAutoCreate,
    expectedCommitmentKey,
    judgedCommitmentKey,
  })),
);

export function commitmentQualityGate(
  sourceClass: string,
  judgmentPolicyVersion: string,
): CommitmentQualityGateReceipt {
  const cases = COMMITMENT_QUALITY_CORPUS.filter((item) =>
    item.sourceClass === sourceClass && item.judgmentPolicyVersion === judgmentPolicyVersion,
  );
  const expectedPositive = cases.filter((item) => item.expectedAutoCreate).length;
  const judgedPositive = cases.filter((item) => item.judgedAutoCreate).length;
  const truePositive = cases.filter((item) => item.expectedAutoCreate && item.judgedAutoCreate).length;
  let falseAutoMerges = 0;
  const judged = cases.filter((item) => item.judgedAutoCreate && item.judgedCommitmentKey);
  for (let left = 0; left < judged.length; left += 1) {
    for (let right = left + 1; right < judged.length; right += 1) {
      if (
        judged[left].judgedCommitmentKey === judged[right].judgedCommitmentKey
        && judged[left].expectedCommitmentKey !== judged[right].expectedCommitmentKey
      ) falseAutoMerges += 1;
    }
  }
  const explicitPromiseRecall = expectedPositive ? truePositive / expectedPositive : 0;
  const autoCreatePrecision = judgedPositive ? truePositive / judgedPositive : 0;
  return {
    corpusVersion: COMMITMENT_CORPUS_VERSION,
    corpusDigest: digest(COMMITMENT_QUALITY_CORPUS),
    sourceClass,
    judgmentPolicyVersion,
    evaluatedCases: cases.length,
    explicitPromiseRecall,
    autoCreatePrecision,
    falseAutoMerges,
    passed: cases.length >= BASE_CASES.length
      && explicitPromiseRecall >= 0.95
      && autoCreatePrecision >= 0.99
      && falseAutoMerges === 0,
  };
}

export function validatedCommitmentSourceClass(provider: SourceProvider | undefined, requested: string): string {
  switch (provider) {
    case "gmail":
    case "outlook_email": return "email";
    case "google_calendar":
    case "outlook_calendar": return "calendar";
    case "granola": return "meeting_notes";
    case "imessage": return "message";
    case "slack": return "slack";
    case "teams": return "teams";
    case "custom":
    case undefined: return requested;
  }
}
