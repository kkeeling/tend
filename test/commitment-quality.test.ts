import { describe, expect, test } from "bun:test";
import {
  COMMITMENT_CORPUS_VERSION,
  COMMITMENT_POLICY_VERSION,
  COMMITMENT_QUALITY_CORPUS,
  commitmentQualityGate,
  validatedCommitmentSourceClass,
} from "../server/workflow/commitmentQuality";

describe("KTD15 commitment quality gate", () => {
  test("passes every auto-create source class at the required thresholds", () => {
    for (const sourceClass of ["email", "meeting_notes", "slack", "teams", "calendar", "message"]) {
      expect(commitmentQualityGate(sourceClass, COMMITMENT_POLICY_VERSION)).toMatchObject({
        corpusVersion: COMMITMENT_CORPUS_VERSION,
        sourceClass,
        evaluatedCases: 12,
        explicitPromiseRecall: 1,
        autoCreatePrecision: 1,
        falseAutoMerges: 0,
        passed: true,
      });
    }
    expect(COMMITMENT_QUALITY_CORPUS).toHaveLength(72);
  });

  test("fails closed for unknown source classes or policy versions", () => {
    expect(commitmentQualityGate("custom", COMMITMENT_POLICY_VERSION).passed).toBe(false);
    expect(commitmentQualityGate("email", "unvalidated-policy").passed).toBe(false);
  });

  test("derives the gate class from the configured provider", () => {
    expect(validatedCommitmentSourceClass("gmail", "untrusted-label")).toBe("email");
    expect(validatedCommitmentSourceClass("granola", "untrusted-label")).toBe("meeting_notes");
    expect(validatedCommitmentSourceClass("imessage", "untrusted-label")).toBe("message");
  });
});
