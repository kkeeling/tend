import type { CommitmentQualityGateReceipt, SourceProvider } from "../../shared/types";
import corpusFixture from "../../test/fixtures/commitment-quality/ktd15-v1.json";
import { digest } from "../util";

export const COMMITMENT_CORPUS_VERSION = corpusFixture.corpusVersion;
export const COMMITMENT_POLICY_VERSION = corpusFixture.policyVersion;
export const COMMITMENT_RECIPE_DIGEST = corpusFixture.evaluator.recipeDigest;

const VALIDATED_SOURCE_CLASSES = ["email", "meeting_notes", "slack", "teams", "calendar", "message"] as const;
export const VALIDATED_COMMITMENT_MODELS = ["gpt-5.6-sol", "claude-opus-4-8"] as const;

interface CorpusCase {
  id: string;
  sourceClass: string;
  judgmentPolicyVersion: string;
  text: string;
  expectedAutoCreate: boolean;
  evaluatedAutoCreate: boolean;
  expectedCommitmentKey: string | null;
  evaluatedCommitmentKey: string | null;
}

function fixtureIsAuditable(): boolean {
  return corpusFixture.privacyReview.status === "approved"
    && corpusFixture.privacyReview.scope.includes("Synthetic examples only")
    && digest(corpusFixture.evaluator.recipe) === corpusFixture.evaluator.recipeDigest;
}

export const COMMITMENT_QUALITY_CORPUS: CorpusCase[] = VALIDATED_SOURCE_CLASSES.flatMap((sourceClass) =>
  corpusFixture.cases.map((item) => ({
    id: `${sourceClass}:${item.id}`,
    sourceClass,
    judgmentPolicyVersion: corpusFixture.policyVersion,
    text: item.text,
    expectedAutoCreate: item.expectedAutoCreate,
    evaluatedAutoCreate: item.evaluatedAutoCreate,
    expectedCommitmentKey: item.expectedCommitmentKey,
    evaluatedCommitmentKey: item.evaluatedCommitmentKey,
  })),
);

export function commitmentQualityGate(
  sourceClass: string,
  judgmentPolicyVersion: string,
  judgment: { model: string; runtime: string; recipeDigest: string },
): CommitmentQualityGateReceipt {
  const cases = COMMITMENT_QUALITY_CORPUS.filter((item) =>
    item.sourceClass === sourceClass && item.judgmentPolicyVersion === judgmentPolicyVersion,
  );
  const expectedPositive = cases.filter((item) => item.expectedAutoCreate).length;
  const evaluatedPositive = cases.filter((item) => item.evaluatedAutoCreate).length;
  const truePositive = cases.filter((item) => item.expectedAutoCreate && item.evaluatedAutoCreate).length;
  let falseAutoMerges = 0;
  const evaluated = cases.filter((item) => item.evaluatedAutoCreate && item.evaluatedCommitmentKey);
  for (let left = 0; left < evaluated.length; left += 1) {
    for (let right = left + 1; right < evaluated.length; right += 1) {
      if (
        evaluated[left].evaluatedCommitmentKey === evaluated[right].evaluatedCommitmentKey
        && evaluated[left].expectedCommitmentKey !== evaluated[right].expectedCommitmentKey
      ) falseAutoMerges += 1;
    }
  }
  const explicitPromiseRecall = expectedPositive ? truePositive / expectedPositive : 0;
  const autoCreatePrecision = evaluatedPositive ? truePositive / evaluatedPositive : 0;
  const validatedModel = (VALIDATED_COMMITMENT_MODELS as readonly string[]).includes(judgment.model);
  return {
    corpusVersion: COMMITMENT_CORPUS_VERSION,
    corpusDigest: digest(corpusFixture.cases),
    sourceClass,
    judgmentPolicyVersion,
    judgmentModel: judgment.model,
    judgmentRuntime: judgment.runtime,
    recipeDigest: judgment.recipeDigest,
    evaluatorModel: corpusFixture.evaluator.model,
    evaluatorRuntime: corpusFixture.evaluator.runtime,
    privacyReviewedAt: corpusFixture.privacyReview.reviewedAt,
    evaluatedCases: cases.length,
    explicitPromiseRecall,
    autoCreatePrecision,
    falseAutoMerges,
    passed: fixtureIsAuditable()
      && cases.length >= corpusFixture.cases.length
      && validatedModel
      && judgment.recipeDigest === COMMITMENT_RECIPE_DIGEST
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
