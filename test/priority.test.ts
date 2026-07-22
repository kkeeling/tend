import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { AttentionStore } from "../server/store";
import { COMMITMENT_RECIPE_DIGEST } from "../server/workflow/commitmentQuality";
import { PRIORITY_RECIPE_DIGEST } from "../server/workflow/priority";

const roots: string[] = [];
const now = new Date("2026-07-21T18:00:00.000Z");

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-priority-"));
  roots.push(root);
  const store = new AttentionStore(root);
  await store.init();
  const domain = new AttentionDomain(store);
  await domain.createFeedFromBrief("Primary Work\nPrimary work.", null);
  await domain.createFeedFromBrief("Side Project\nSide project.", null);
  const primarySource = await domain.addSourceFromBrief("primary-work", "Read synthetic notes.");
  const sideSource = await domain.addSourceFromBrief("side-project", "Read synthetic notes.");
  const primaryRun = await domain.recordSourceRun("primary-work", primarySource.id, [{ id: "p" }], [], { cursor: "p" });
  const sideRun = await domain.recordSourceRun("side-project", sideSource.id, [{ id: "s" }], [], { cursor: "s" });
  const rule = await domain.activateInitialPriorityRules({
    domainOrder: ["primary-work", "side-project"],
    imminentWithinMinutes: 90,
    severeConsequenceOverride: true,
  }, "Approve the initial private domain ordering.");
  return { store, domain, primarySource, sideSource, primaryRun, sideRun, rule };
}

async function commitment(
  domain: AttentionDomain,
  feedId: string,
  sourceId: string,
  sourceRunId: string,
  key: string,
  promise: string,
  context: { domain: string; consequence: "low" | "medium" | "high" | "severe"; dueAt?: string },
) {
  return (await domain.recordCommitmentCandidate(feedId, {
    sourceId,
    sourceRunId,
    snapshotId: "snapshot-1",
    signalKind: "custom",
    deduplicationKey: key,
    explicitness: "explicit_first_person_bounded",
    certainty: 0.95,
    normalized: { promise, ...(context.dueAt ? { dueAt: context.dueAt } : {}) },
    priorityContext: { domain: context.domain, consequence: context.consequence },
    judgmentPolicyVersion: "commitment-v1",
    judgmentModel: "gpt-5.6-sol",
    judgmentRuntime: "bun-test",
    judgmentRecipeDigest: COMMITMENT_RECIPE_DIGEST,
    sourceClass: "meeting_notes",
    qualityGatePassed: true,
    ownerHint: { feedId },
  })).commitment!;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("priority rules and ledger", () => {
  test("ranks an urgent non-commitment reply card in the same Now order", async () => {
    const { store, domain, sideSource, sideRun } = await setup();
    await commitment(domain, "side-project", sideSource.id, sideRun, "side-normal", "Review the side-project experiment", { domain: "side-project", consequence: "medium" });
    await domain.upsertCard("primary-work", {
      id: "urgent-reply-without-commitment",
      title: "Reply before today's filing deadline",
      why: "This urgent decision is actionable even though it is not a promise.",
      blocks: [{ id: "draft", type: "editable_text", label: "Suggested reply", value: "I can confirm the filing details.", editable: true }],
      actions: [{ id: "prepare", label: "Review reply", behavior: "queue_instruction", instruction: "Review and refine this reply.", variant: "primary" }],
      attentionPriority: {
        domain: "primary-work",
        consequence: "high",
        dueAt: "2026-07-21T18:30:00.000Z",
        certainty: 0.99,
        judgmentPolicyVersion: "priority-v1",
        judgmentModel: "gpt-5.6-sol",
        judgmentRuntime: "bun-test",
        judgmentRecipeDigest: PRIORITY_RECIPE_DIGEST,
      },
    });

    const nowView = (await store.readWorkspaceControlPlane(now)).now;
    expect(nowView.items[0]).toMatchObject({
      id: "primary-work:urgent-reply-without-commitment",
      priority: { ruleVersion: 1, judgmentModel: "gpt-5.6-sol", judgmentRecipeDigest: PRIORITY_RECIPE_DIGEST },
    });
    expect(nowView.items[0].commitment).toBeUndefined();
    expect(nowView.items[0].card.actions?.[0].label).toBe("Review reply");
  });

  test("ranks primary work first when comparable and records a replayable explanation", async () => {
    const { store, domain, primarySource, sideSource, primaryRun, sideRun, rule } = await setup();
    const primary = await commitment(domain, "primary-work", primarySource.id, primaryRun, "primary", "Prepare launch brief", { domain: "primary-work", consequence: "medium" });
    await commitment(domain, "side-project", sideSource.id, sideRun, "side", "Review experiment", { domain: "side-project", consequence: "medium" });

    const first = await domain.evaluateWorkspacePriorities("judgment-v1", now);
    const second = await domain.evaluateWorkspacePriorities("judgment-v1", now);
    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({ commitmentId: primary.id, ruleVersion: rule.version });
    expect(first[0].explanation).toContain("primary-work");
    expect((await store.listPriorityLedger()).filter((entry) => entry.type === "evaluation")).toHaveLength(4);
  });

  test("refreshes the materialized ordering as commitments arrive and on workspace reads", async () => {
    const { store, domain, primarySource, sideSource, primaryRun, sideRun } = await setup();
    const primary = await commitment(domain, "primary-work", primarySource.id, primaryRun, "primary-auto-refresh", "Prepare launch brief", { domain: "primary-work", consequence: "medium" });
    await commitment(domain, "side-project", sideSource.id, sideRun, "side-auto-refresh", "Review experiment", { domain: "side-project", consequence: "medium" });
    expect((await store.readWorkspaceNowProjection())[0]).toMatchObject({ commitmentId: primary.id, judgmentPolicyVersion: "priority-v1" });
    expect((await domain.refreshWorkspacePriorities())[0]).toMatchObject({ commitmentId: primary.id });
  });

  test("allows an imminent severe lower-domain item to override with a visible ledger reason", async () => {
    const { store, domain, primarySource, sideSource, primaryRun, sideRun } = await setup();
    await commitment(domain, "primary-work", primarySource.id, primaryRun, "primary-normal", "Prepare launch brief", { domain: "primary-work", consequence: "medium" });
    const urgent = await commitment(domain, "side-project", sideSource.id, sideRun, "side-urgent", "Restore production access", {
      domain: "side-project",
      consequence: "severe",
      dueAt: "2026-07-21T19:00:00.000Z",
    });

    const rows = await domain.evaluateWorkspacePriorities("judgment-v1", now);
    expect(rows[0]).toMatchObject({ commitmentId: urgent.id, overrideReason: expect.stringContaining("imminent") });
    expect((await store.listPriorityLedger()).some((entry) => entry.type === "override" && entry.commitmentId === urgent.id)).toBe(true);
  });

  test("does not let ordinary due-date scoring bypass the approved domain order", async () => {
    const { domain, primarySource, sideSource, primaryRun, sideRun } = await setup();
    const primary = await commitment(domain, "primary-work", primarySource.id, primaryRun, "primary-normal-due", "Prepare launch brief", { domain: "primary-work", consequence: "medium" });
    await commitment(domain, "side-project", sideSource.id, sideRun, "side-tomorrow", "Review tomorrow's experiment", {
      domain: "side-project",
      consequence: "medium",
      dueAt: "2026-07-22T17:00:00.000Z",
    });

    const rows = await domain.evaluateWorkspacePriorities("judgment-v1", now);
    expect(rows[0]).toMatchObject({ commitmentId: primary.id });
    expect(rows.every((row) => row.overrideReason === undefined)).toBe(true);
  });

  test("allows high-consequence lower-domain work to override with a visible reason", async () => {
    const { domain, primarySource, sideSource, primaryRun, sideRun } = await setup();
    await commitment(domain, "primary-work", primarySource.id, primaryRun, "primary-high-override", "Prepare launch brief", { domain: "primary-work", consequence: "medium" });
    const urgent = await commitment(domain, "side-project", sideSource.id, sideRun, "side-high-override", "Prevent customer data loss", {
      domain: "side-project",
      consequence: "high",
    });

    expect((await domain.evaluateWorkspacePriorities("judgment-v1", now))[0]).toMatchObject({
      commitmentId: urgent.id,
      overrideReason: expect.stringContaining("high consequence"),
    });
  });

  test("keeps ordering unchanged until the exact correction proposal is approved", async () => {
    const { domain, primarySource, sideSource, primaryRun, sideRun } = await setup();
    const primary = await commitment(domain, "primary-work", primarySource.id, primaryRun, "primary-correct", "Prepare launch brief", { domain: "primary-work", consequence: "medium" });
    const side = await commitment(domain, "side-project", sideSource.id, sideRun, "side-correct", "Review experiment", { domain: "side-project", consequence: "medium" });
    expect((await domain.evaluateWorkspacePriorities("judgment-v1", now))[0].commitmentId).toBe(primary.id);

    const proposal = await domain.recordPriorityCorrection({
      preferredCommitmentId: side.id,
      overCommitmentId: primary.id,
      reason: "For this evaluation, prefer the side project domain.",
      proposedRules: {
        domainOrder: ["side-project", "primary-work"],
        imminentWithinMinutes: 90,
        severeConsequenceOverride: true,
      },
    });
    expect((await domain.evaluateWorkspacePriorities("judgment-v1", now))[0].commitmentId).toBe(primary.id);

    await domain.approvePriorityRuleProposal(proposal.id);
    expect((await domain.evaluateWorkspacePriorities("judgment-v1", now))[0].commitmentId).toBe(side.id);
  });
});
