import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { createLocalRuntime } from "../server/runtime";
import { projectCoverage } from "../server/workflow/coverage";
import type { SourceAttempt, SourceRecipe } from "../shared/types";

const now = "2026-07-21T18:00:00.000Z";

function source(overrides: Partial<SourceRecipe> = {}): SourceRecipe {
  return {
    id: "mailbox-work-a",
    name: "Work mailbox A",
    filename: "mailbox-work-a.md",
    checkpointFilename: "mailbox-work-a.json",
    summary: "Collect bounded work mail.",
    profile: {
      provider: "outlook_email",
      expectedIdentity: { account: "mailbox-work-a" },
      required: true,
      cadenceMinutes: 15,
      freshnessMinutes: 20,
      lookbackDays: 30,
      onboardingState: "connected",
      actionCapabilities: ["read", "prepare_reply"],
    },
    ...overrides,
  };
}

function attempt(overrides: Partial<SourceAttempt> = {}): SourceAttempt {
  return {
    id: "attempt-1",
    feedId: "primary-work",
    sourceId: "mailbox-work-a",
    outcome: "success",
    startedAt: "2026-07-21T17:50:00.000Z",
    completedAt: "2026-07-21T17:51:00.000Z",
    observedIdentity: { account: "mailbox-work-a" },
    completeness: {
      identityVerified: true,
      scopeVerified: true,
      permissionsComplete: true,
      paginationComplete: true,
      backfillComplete: true,
    },
    checkpointAdvanced: true,
    ...overrides,
  };
}

describe("workspace source coverage", () => {
  test("requires a complete, identity-matched fresh attempt for all-clear", () => {
    const complete = projectCoverage(
      [{ feedId: "primary-work", recipe: source() }],
      [attempt()],
      new Date(now),
    );
    expect(complete.allClear).toBe(true);
    expect(complete.sources[0]).toMatchObject({ state: "fresh", required: true });

    const partial = projectCoverage(
      [{ feedId: "primary-work", recipe: source() }],
      [attempt({ id: "attempt-partial", outcome: "partial", completeness: { ...attempt().completeness, paginationComplete: false } })],
      new Date(now),
    );
    expect(partial.allClear).toBe(false);
    expect(partial.sources[0]).toMatchObject({ state: "partial", allClearEligible: false });

    const mismatched = projectCoverage(
      [{ feedId: "primary-work", recipe: source() }],
      [attempt({ id: "attempt-mismatch", outcome: "identity_mismatch", observedIdentity: { account: "mailbox-work-b" }, checkpointAdvanced: false })],
      new Date(now),
    );
    expect(mismatched.allClear).toBe(false);
    expect(mismatched.sources[0]).toMatchObject({ state: "identity_mismatch", lastGoodAt: null });
  });

  test("matches provider identities using the same case-normalized contract as action verification", () => {
    const slack = source({
      profile: {
        ...source().profile!,
        provider: "slack",
        expectedIdentity: { account: "u0abc123", workspace: "t0workspace" },
      },
    });
    const coverage = projectCoverage(
      [{ feedId: "side-project", recipe: slack }],
      [attempt({
        feedId: "side-project",
        sourceId: slack.id,
        observedIdentity: { account: "U0ABC123", workspace: "T0WORKSPACE" },
      })],
      new Date(now),
    );

    expect(coverage.allClear).toBe(true);
    expect(coverage.sources[0]).toMatchObject({ state: "fresh", lastGoodAt: expect.any(String) });
  });

  test("preserves the last successful boundary while exposing the latest failure", () => {
    const coverage = projectCoverage(
      [{ feedId: "primary-work", recipe: source() }],
      [
        attempt({ id: "attempt-good", completedAt: "2026-07-21T17:45:00.000Z" }),
        attempt({
          id: "attempt-denied",
          outcome: "permission_denied",
          startedAt: "2026-07-21T17:54:00.000Z",
          completedAt: "2026-07-21T17:55:00.000Z",
          checkpointAdvanced: false,
          completeness: undefined,
          error: { class: "permission_denied", message: "Consent is missing." },
        }),
      ],
      new Date(now),
    );

    expect(coverage.allClear).toBe(false);
    expect(coverage.sources[0]).toMatchObject({
      state: "permission_denied",
      lastAttemptAt: "2026-07-21T17:55:00.000Z",
      lastGoodAt: "2026-07-21T17:45:00.000Z",
      remediation: expect.stringContaining("permission"),
    });
  });

  test("does not call authorization or a heartbeat collection coverage", () => {
    const authorization = projectCoverage(
      [{ feedId: "primary-work", recipe: source({ profile: { ...source().profile!, onboardingState: "authorization_required" } }) }],
      [],
      new Date(now),
    );
    expect(authorization.allClear).toBe(false);
    expect(authorization.sources[0].state).toBe("authorization_required");

    const connected = projectCoverage(
      [{ feedId: "primary-work", recipe: source() }],
      [],
      new Date(now),
    );
    expect(connected.allClear).toBe(false);
    expect(connected.sources[0].state).toBe("connected_not_collected");
  });

  test("persists immutable attempts and keeps the checkpoint on failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tend-coverage-"));
    const runtime = await createLocalRuntime(path.join(root, "data"), path.join(root, "attention.db"));
    try {
      const domain = new AttentionDomain(runtime.store);
      await runtime.store.addSource("inbox", source(), "# Work mailbox A\n");
      await domain.recordSourceRun("inbox", "mailbox-work-a", [], [], { cursor: "good" }, undefined, undefined, {
        outcome: "success",
        observedIdentity: { account: "mailbox-work-a" },
        completeness: attempt().completeness!,
      });

      await domain.recordSourceAttempt("inbox", "mailbox-work-a", {
        outcome: "rate_limited",
        observedIdentity: { account: "mailbox-work-a" },
        error: { class: "rate_limited", message: "Try later." },
      });

      expect(await runtime.store.readSourceCheckpoint("inbox", "mailbox-work-a")).toEqual({ cursor: "good" });
      const attempts = await runtime.store.listSourceAttempts("inbox", "mailbox-work-a");
      expect(attempts.map((item) => item.outcome)).toEqual(["success", "rate_limited"]);
      const mirror = await readFile(path.join(root, "data", "feeds", "inbox", "source-attempts.jsonl"), "utf8");
      expect(mirror.trim().split("\n")).toHaveLength(2);
      expect(mirror).not.toContain("Try later.\nTry later.");

      const beforeRestart = await runtime.store.readWorkspaceCoverage(new Date(now));
      expect(beforeRestart.sources.find((item) => item.sourceId === "mailbox-work-a")).toMatchObject({
        state: "rate_limited",
        lastGoodAt: expect.any(String),
      });
      runtime.sqlite.close();
      const restarted = await createLocalRuntime(path.join(root, "data"), path.join(root, "attention.db"));
      try {
        expect(await restarted.store.readWorkspaceCoverage(new Date(now))).toEqual(beforeRestart);
      } finally {
        restarted.sqlite.close();
      }
    } finally {
      runtime.sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects incomplete successful proofs before advancing the checkpoint", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tend-coverage-incomplete-"));
    const runtime = await createLocalRuntime(path.join(root, "data"), path.join(root, "attention.db"));
    try {
      const domain = new AttentionDomain(runtime.store);
      await runtime.store.addSource("inbox", source(), "# Work mailbox A\n");
      const before = await runtime.store.readSourceCheckpoint("inbox", "mailbox-work-a");
      await expect(domain.recordSourceRun("inbox", "mailbox-work-a", [], [], { cursor: "must-not-advance" }, undefined, undefined, {
        outcome: "success",
        observedIdentity: { account: "mailbox-work-a" },
        completeness: { identityVerified: true } as SourceAttempt["completeness"],
      })).rejects.toThrow("requires complete identity");
      expect(await runtime.store.readSourceCheckpoint("inbox", "mailbox-work-a")).toEqual(before);
      expect(await runtime.store.listSourceAttempts("inbox", "mailbox-work-a")).toHaveLength(0);
    } finally {
      runtime.sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
