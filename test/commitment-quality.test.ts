import { describe, expect, test } from "bun:test";
import {
  COMMITMENT_CORPUS_VERSION,
  COMMITMENT_POLICY_VERSION,
  COMMITMENT_QUALITY_CORPUS,
  COMMITMENT_RECIPE_DIGEST,
  commitmentQualityGate,
  validatedCommitmentSourceClass,
} from "../server/workflow/commitmentQuality";

describe("KTD15 commitment quality gate", () => {
  const judgment = { model: "gpt-5.6-sol", runtime: "bun-test", recipeDigest: COMMITMENT_RECIPE_DIGEST };

  test("passes every auto-create source class at the required thresholds", () => {
    for (const sourceClass of ["email", "meeting_notes", "slack", "teams", "calendar", "message"]) {
      expect(commitmentQualityGate(sourceClass, COMMITMENT_POLICY_VERSION, judgment)).toMatchObject({
        corpusVersion: COMMITMENT_CORPUS_VERSION,
        sourceClass,
        judgmentModel: "gpt-5.6-sol",
        judgmentRuntime: "bun-test",
        recipeDigest: COMMITMENT_RECIPE_DIGEST,
        evaluatedCases: 16,
        explicitPromiseRecall: 1,
        autoCreatePrecision: 1,
        falseAutoMerges: 0,
        passed: true,
      });
    }
    expect(COMMITMENT_QUALITY_CORPUS).toHaveLength(96);
  });

  test("fails closed for unknown source classes, policies, models, or recipe digests", () => {
    expect(commitmentQualityGate("custom", COMMITMENT_POLICY_VERSION, judgment).passed).toBe(false);
    expect(commitmentQualityGate("email", "unvalidated-policy", judgment).passed).toBe(false);
    expect(commitmentQualityGate("email", COMMITMENT_POLICY_VERSION, { ...judgment, model: "unvalidated-model" }).passed).toBe(false);
    expect(commitmentQualityGate("email", COMMITMENT_POLICY_VERSION, { ...judgment, recipeDigest: "wrong-recipe" }).passed).toBe(false);
  });

  test("derives the gate class from the configured provider", () => {
    expect(validatedCommitmentSourceClass("gmail", "untrusted-label")).toBe("email");
    expect(validatedCommitmentSourceClass("granola", "untrusted-label")).toBe("meeting_notes");
    expect(validatedCommitmentSourceClass("imessage", "untrusted-label")).toBe("message");
  });
});
