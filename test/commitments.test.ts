import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { AttentionStore } from "../server/store";
import { createLocalRuntime } from "../server/runtime";
import { COMMITMENT_RECIPE_DIGEST } from "../server/workflow/commitmentQuality";

const roots: string[] = [];
const TEST_JUDGMENT = {
  judgmentModel: "gpt-5.6-sol",
  judgmentRuntime: "bun-test",
  judgmentRecipeDigest: COMMITMENT_RECIPE_DIGEST,
};

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-commitments-"));
  roots.push(root);
  const store = new AttentionStore(root);
  await store.init();
  const domain = new AttentionDomain(store);
  await domain.createFeedFromBrief("Primary Work\nHandle primary work commitments.", null);
  await domain.createFeedFromBrief("Side Project\nHandle side project commitments.", null);
  await domain.addSourceFromBrief("primary-work", "Read synthetic meeting notes.");
  await domain.addSourceFromBrief("side-project", "Read synthetic email follow-ups.");
  const primarySource = (await store.readFeed("primary-work")).sources[0];
  const sideSource = (await store.readFeed("side-project")).sources[0];
  const primaryRun = await domain.recordSourceRun("primary-work", primarySource.id, [{ id: "note-1" }], [], { cursor: "note-1" });
  const sideRun = await domain.recordSourceRun("side-project", sideSource.id, [{ id: "mail-1" }], [], { cursor: "mail-1" });
  return { store, domain, primarySource, sideSource, primaryRun, sideRun };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace commitments", () => {
  test("converges simultaneous explicit signals on one owner card and retains both receipts", async () => {
    const { store, domain, primarySource, sideSource, primaryRun, sideRun } = await setup();
    const normalized = {
      promise: "Send the revised launch brief",
      deliverable: "Revised launch brief",
      dueAt: "2026-07-24T17:00:00.000Z",
    };
    const [fromMeeting, fromEmail] = await Promise.all([
      domain.recordCommitmentCandidate("primary-work", {
        sourceId: primarySource.id,
        sourceRunId: primaryRun,
        snapshotId: "snapshot-1",
        signalKind: "meeting_note",
        deduplicationKey: "launch-brief-v1",
        explicitness: "explicit_first_person_bounded",
        certainty: 0.98,
        normalized,
        judgmentPolicyVersion: "commitment-v1",
        ...TEST_JUDGMENT,
        sourceClass: "meeting_notes",
        qualityGatePassed: true,
        ownerHint: { feedId: "primary-work" },
      }),
      domain.recordCommitmentCandidate("side-project", {
        sourceId: sideSource.id,
        sourceRunId: sideRun,
        snapshotId: "snapshot-1",
        signalKind: "email",
        deduplicationKey: "launch-brief-v1",
        explicitness: "explicit_first_person_bounded",
        certainty: 0.96,
        normalized,
        judgmentPolicyVersion: "commitment-v1",
        ...TEST_JUDGMENT,
        sourceClass: "email",
        qualityGatePassed: true,
        ownerHint: { feedId: "primary-work" },
      }),
    ]);

    expect(fromMeeting.commitment).not.toBeNull();
    expect(fromEmail.commitment).toBeNull();
    expect(fromEmail.candidate).toMatchObject({
      status: "pending_confirmation",
      reconciliation: {
        kind: "cross_feed_link",
        proposedCommitmentId: fromMeeting.commitment!.id,
        expectedCommitmentVersion: fromMeeting.commitment!.version,
      },
      confirmationCard: { feedId: "primary-work" },
    });
    let commitments = await store.listWorkspaceCommitments();
    expect(commitments).toHaveLength(1);
    expect(commitments[0].signals).toHaveLength(1);
    const ownerCardBefore = await store.readCard("primary-work", commitments[0].owner.cardId);
    expect(ownerCardBefore.blocks.find((block) => block.id === "source-receipts")).toMatchObject({ text: "1 attributable source receipt." });

    const reconciled = await domain.confirmCommitmentCandidate(fromEmail.candidate.id, true);
    expect(reconciled.commitment?.id).toBe(fromMeeting.commitment!.id);
    commitments = await store.listWorkspaceCommitments();
    expect(commitments).toHaveLength(1);
    expect(commitments[0].signals).toHaveLength(2);
    expect(commitments[0].owner.feedId).toBe("primary-work");
    expect(await store.hasCard("primary-work", commitments[0].owner.cardId)).toBe(true);
    expect((await store.readCard("primary-work", commitments[0].owner.cardId)).sourceRunIds).toBeUndefined();
  });

  test("does not silently merge similar-but-distinct obligations that share a deduplication key", async () => {
    const { store, domain, primarySource, primaryRun } = await setup();
    const first = await domain.recordCommitmentCandidate("primary-work", {
      sourceId: primarySource.id,
      sourceRunId: primaryRun,
      snapshotId: "snapshot-1",
      sourceSignalKey: "launch-deck",
      signalKind: "meeting_note",
      deduplicationKey: "mistaken-shared-key",
      explicitness: "explicit_first_person_bounded",
      certainty: 0.99,
      normalized: { promise: "Send the revised launch deck", deliverable: "Launch deck" },
      judgmentPolicyVersion: "commitment-v1",
      ...TEST_JUDGMENT,
      sourceClass: "meeting_notes",
      qualityGatePassed: true,
      ownerHint: { feedId: "primary-work" },
    });
    const second = await domain.recordCommitmentCandidate("primary-work", {
      sourceId: primarySource.id,
      sourceRunId: primaryRun,
      snapshotId: "snapshot-1",
      sourceSignalKey: "investor-deck",
      signalKind: "meeting_note",
      deduplicationKey: "mistaken-shared-key",
      explicitness: "explicit_first_person_bounded",
      certainty: 0.99,
      normalized: { promise: "Send the revised investor deck", deliverable: "Investor deck" },
      judgmentPolicyVersion: "commitment-v1",
      ...TEST_JUDGMENT,
      sourceClass: "meeting_notes",
      qualityGatePassed: true,
      ownerHint: { feedId: "primary-work" },
    });

    expect(second.commitment).toBeNull();
    expect(second.candidate.reconciliation?.kind).toBe("same_feed_match_review");
    expect((await store.readWorkspaceCommitment(first.commitment!.id)).signals).toHaveLength(1);
    const keptSeparate = await domain.confirmCommitmentCandidate(second.candidate.id, false);
    expect(keptSeparate.commitment?.id).not.toBe(first.commitment!.id);
    expect(await store.listWorkspaceCommitments()).toHaveLength(2);
  });

  test("requires confirmation for ambiguous text or a failing source-class gate", async () => {
    const { store, domain, primarySource, primaryRun } = await setup();
    const ambiguous = await domain.recordCommitmentCandidate("primary-work", {
      sourceId: primarySource.id,
      sourceRunId: primaryRun,
      snapshotId: "snapshot-1",
      signalKind: "meeting_note",
      deduplicationKey: "metrics-request",
      explicitness: "ambiguous",
      certainty: 0.62,
      normalized: { promise: "Send the metrics" },
      judgmentPolicyVersion: "commitment-v1",
      ...TEST_JUDGMENT,
      sourceClass: "meeting_notes",
      qualityGatePassed: true,
      ownerHint: { feedId: "primary-work" },
    });
    expect(ambiguous.candidate.status).toBe("pending_confirmation");
    expect(ambiguous.commitment).toBeNull();
    const confirmationCard = await store.readCard("primary-work", ambiguous.candidate.confirmationCard!.cardId);
    expect(confirmationCard.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "accept-commitment", behavior: "queue_instruction", label: "Yes, add this commitment" }),
      expect.objectContaining({ id: "reject-commitment", behavior: "queue_instruction", label: "No, reject this commitment" }),
    ]));

    const gated = await domain.recordCommitmentCandidate("primary-work", {
      sourceId: primarySource.id,
      sourceRunId: primaryRun,
      snapshotId: "snapshot-1",
      signalKind: "meeting_note",
      deduplicationKey: "gated-promise",
      explicitness: "explicit_first_person_bounded",
      certainty: 0.99,
      normalized: { promise: "Send the appendix" },
      judgmentPolicyVersion: "commitment-v1",
      ...TEST_JUDGMENT,
      sourceClass: "meeting_notes",
      qualityGatePassed: false,
      ownerHint: { feedId: "primary-work" },
    });
    expect(gated.candidate.status).toBe("pending_confirmation");
    expect(await store.listWorkspaceCommitments()).toHaveLength(0);

    const unvalidated = await domain.recordCommitmentCandidate("primary-work", {
      sourceId: primarySource.id,
      sourceRunId: primaryRun,
      snapshotId: "snapshot-1",
      signalKind: "custom",
      deduplicationKey: "unvalidated-source-class",
      explicitness: "explicit_first_person_bounded",
      certainty: 0.99,
      normalized: { promise: "Send the unvalidated appendix" },
      judgmentPolicyVersion: "commitment-v1",
      ...TEST_JUDGMENT,
      sourceClass: "unvalidated-source",
      qualityGatePassed: true,
      ownerHint: { feedId: "primary-work" },
    });
    expect(unvalidated.candidate).toMatchObject({
      status: "pending_confirmation",
      qualityGatePassed: false,
      qualityGate: { passed: false, evaluatedCases: 0 },
    });

    const accepted = await domain.confirmCommitmentCandidate(ambiguous.candidate.id, true);
    expect(accepted.commitment?.status).toBe("open");
    expect((await store.readCommitmentCandidate(ambiguous.candidate.id)).status).toBe("accepted");
  });

  test("rejects unsafe owner ids and invalid agent-supplied commitment enums", async () => {
    const { domain, primarySource, primaryRun } = await setup();
    const base = {
      sourceId: primarySource.id,
      sourceRunId: primaryRun,
      snapshotId: "snapshot-1",
      signalKind: "meeting_note" as const,
      deduplicationKey: "candidate-validation",
      explicitness: "explicit_first_person_bounded" as const,
      certainty: 0.99,
      normalized: { promise: "Send the validated brief" },
      judgmentPolicyVersion: "commitment-v1",
      ...TEST_JUDGMENT,
      sourceClass: "meeting_notes",
      qualityGatePassed: true,
      ownerHint: { feedId: "primary-work" },
    };
    await expect(domain.recordCommitmentCandidate("primary-work", {
      ...base,
      ownerHint: { feedId: "primary-work", cardId: "../outside" },
    })).rejects.toThrow("owner card id");
    await expect(domain.recordCommitmentCandidate("primary-work", {
      ...base,
      explicitness: "model_guessed" as never,
    })).rejects.toThrow("explicitness is unsupported");
    await expect(domain.recordCommitmentCandidate("primary-work", {
      ...base,
      priorityContext: { domain: "primary-work", consequence: "catastrophic" as never },
    })).rejects.toThrow("consequence is unsupported");
  });

  test("keeps lifecycle history when completion is uncertain and later contradicted", async () => {
    const { store, domain, primarySource, primaryRun } = await setup();
    const recorded = await domain.recordCommitmentCandidate("primary-work", {
      sourceId: primarySource.id,
      sourceRunId: primaryRun,
      snapshotId: "snapshot-1",
      signalKind: "meeting_note",
      deduplicationKey: "reopenable",
      explicitness: "explicit_first_person_bounded",
      certainty: 0.99,
      normalized: { promise: "Send the final brief" },
      judgmentPolicyVersion: "commitment-v1",
      ...TEST_JUDGMENT,
      sourceClass: "meeting_notes",
      qualityGatePassed: true,
      ownerHint: { feedId: "primary-work" },
    });
    const commitmentId = recorded.commitment!.id;
    await domain.transitionCommitment(commitmentId, "completion_pending", "A follow-up suggests it may be done.");
    await domain.transitionCommitment(commitmentId, "fulfilled", "The recipient confirmed delivery.");
    await domain.transitionCommitment(commitmentId, "reopened", "A later message says the attachment was missing.");

    expect((await store.readWorkspaceCommitment(commitmentId)).status).toBe("reopened");
    expect((await store.listCommitmentEvents(commitmentId)).map((event) => event.type)).toEqual([
      "created",
      "signal_linked",
      "lifecycle_changed",
      "lifecycle_changed",
      "lifecycle_changed",
    ]);
  });

  test("maps typed source evidence to completion-pending, fulfilled, and reopened states", async () => {
    const { store, domain, primarySource, primaryRun } = await setup();
    const recorded = await domain.recordCommitmentCandidate("primary-work", {
      sourceId: primarySource.id,
      sourceRunId: primaryRun,
      snapshotId: "snapshot-1",
      signalKind: "meeting_note",
      deduplicationKey: "completion-evidence-flow",
      explicitness: "explicit_first_person_bounded",
      certainty: 0.99,
      normalized: { promise: "Send the completion evidence brief" },
      judgmentPolicyVersion: "commitment-v1",
      ...TEST_JUDGMENT,
      sourceClass: "meeting_notes",
      qualityGatePassed: true,
      ownerHint: { feedId: "primary-work" },
    });
    const evidence = {
      sourceFeedId: "primary-work",
      sourceId: primarySource.id,
      sourceRunId: primaryRun,
      snapshotId: "snapshot-1",
    };

    expect((await domain.recordCommitmentCompletionEvidence(recorded.commitment!.id, {
      ...evidence,
      evidenceKind: "ambiguous_completion",
      summary: "The meeting suggests the brief may have been sent.",
    })).status).toBe("completion_pending");
    expect((await domain.recordCommitmentCompletionEvidence(recorded.commitment!.id, {
      ...evidence,
      evidenceKind: "clear_completion",
      summary: "The recipient explicitly confirmed delivery.",
    })).status).toBe("fulfilled");
    expect((await domain.recordCommitmentCompletionEvidence(recorded.commitment!.id, {
      ...evidence,
      evidenceKind: "contradiction",
      summary: "A later message says the attachment was missing.",
    })).status).toBe("reopened");

    const events = await store.listCommitmentEvents(recorded.commitment!.id);
    expect(events.filter((event) => event.type === "completion_evidence")).toHaveLength(3);
    expect((await store.readCard("primary-work", recorded.commitment!.owner.cardId)).status).toBe("to_review_updated");
  });

  test("preserves prior provenance when a source signal is edited, deleted, or retracted", async () => {
    const { store, domain, primarySource, primaryRun } = await setup();
    const recorded = await domain.recordCommitmentCandidate("primary-work", {
      sourceId: primarySource.id,
      sourceRunId: primaryRun,
      snapshotId: "snapshot-1",
      signalKind: "meeting_note",
      deduplicationKey: "source-change-provenance",
      explicitness: "explicit_first_person_bounded",
      certainty: 0.99,
      normalized: { promise: "Preserve this prior source claim" },
      judgmentPolicyVersion: "commitment-v1",
      ...TEST_JUDGMENT,
      sourceClass: "meeting_notes",
      qualityGatePassed: true,
      ownerHint: { feedId: "primary-work" },
    });
    await domain.recordCommitmentSignalChange(recorded.candidate.id, {
      kind: "retracted",
      reason: "The source author retracted the statement; confirmation is required.",
    });

    const preserved = await store.readWorkspaceCommitment(recorded.commitment!.id);
    expect(preserved.signals).toEqual([recorded.candidate.signal]);
    expect((await store.listCommitmentEvents(preserved.id)).at(-1)).toMatchObject({ type: "signal_changed", detail: { kind: "retracted" } });
    expect((await store.readCard(preserved.owner.feedId, preserved.owner.cardId))).toMatchObject({
      status: "to_review_updated",
      blocks: expect.arrayContaining([expect.objectContaining({ label: "Source evidence changed" })]),
    });
  });

  test("re-homes a versioned owner card but refuses while active work exists", async () => {
    const { store, domain, primarySource, primaryRun } = await setup();
    const first = await domain.recordCommitmentCandidate("primary-work", {
      sourceId: primarySource.id,
      sourceRunId: primaryRun,
      snapshotId: "snapshot-1",
      sourceSignalKey: "rehome-success",
      signalKind: "meeting_note",
      deduplicationKey: "rehome-success",
      explicitness: "explicit_first_person_bounded",
      certainty: 0.99,
      normalized: { promise: "Move this commitment to the side project" },
      judgmentPolicyVersion: "commitment-v1",
      ...TEST_JUDGMENT,
      sourceClass: "meeting_notes",
      qualityGatePassed: true,
      ownerHint: { feedId: "primary-work" },
    });
    const previousOwner = first.commitment!.owner;
    const moved = await domain.rehomeCommitment(first.commitment!.id, {
      targetFeedId: "side-project",
      expectedVersion: first.commitment!.version,
      reason: "This obligation belongs with the side-project workflow.",
    });
    expect(moved.owner).toEqual({ feedId: "side-project", cardId: previousOwner.cardId });
    expect(await store.hasCard(previousOwner.feedId, previousOwner.cardId)).toBe(false);
    expect(await store.hasCard(moved.owner.feedId, moved.owner.cardId)).toBe(true);
    expect((await store.listCommitmentEvents(moved.id)).at(-1)).toMatchObject({ type: "owner_changed" });

    const secondRun = await domain.recordSourceRun("primary-work", primarySource.id, [{ id: "note-2" }], [], { cursor: "note-2" });
    const second = await domain.recordCommitmentCandidate("primary-work", {
      sourceId: primarySource.id,
      sourceRunId: secondRun,
      snapshotId: "snapshot-1",
      sourceSignalKey: "rehome-blocked",
      signalKind: "meeting_note",
      deduplicationKey: "rehome-blocked",
      explicitness: "explicit_first_person_bounded",
      certainty: 0.99,
      normalized: { promise: "Keep active work pinned to its current owner" },
      judgmentPolicyVersion: "commitment-v1",
      ...TEST_JUDGMENT,
      sourceClass: "meeting_notes",
      qualityGatePassed: true,
      ownerHint: { feedId: "primary-work" },
    });
    await domain.queueWorkspaceInstruction({
      cardRef: second.commitment!.owner,
      commitmentId: second.commitment!.id,
      expectedCommitmentVersion: second.commitment!.version,
      instruction: "Start handling this commitment.",
    });
    await expect(domain.rehomeCommitment(second.commitment!.id, {
      targetFeedId: "side-project",
      expectedVersion: second.commitment!.version,
      reason: "Attempt to move active work.",
    })).rejects.toThrow("queued, working, or approved work");
  });

  test("enriches an existing owner card without replacing its draft or CTA", async () => {
    const { store, domain, primarySource, primaryRun } = await setup();
    await domain.upsertCard("primary-work", {
      id: "existing-mail-card",
      title: "Reply with the revised brief",
      why: "The recipient is waiting for a promised update.",
      blocks: [{ id: "draft", type: "editable_text", label: "Suggested reply", value: "Here is the revised brief." }],
      actions: [{
        id: "prepare-reply",
        label: "Prepare reply",
        behavior: "queue_instruction",
        instruction: "Prepare the exact reply for review.",
        variant: "primary",
      }],
    });

    const recorded = await domain.recordCommitmentCandidate("primary-work", {
      sourceId: primarySource.id,
      sourceRunId: primaryRun,
      snapshotId: "snapshot-1",
      sourceSignalKey: "existing-card-promise",
      signalKind: "email",
      deduplicationKey: "existing-card-commitment",
      explicitness: "explicit_first_person_bounded",
      certainty: 0.99,
      normalized: { promise: "Send the revised brief" },
      judgmentPolicyVersion: "commitment-v1",
      ...TEST_JUDGMENT,
      sourceClass: "email",
      qualityGatePassed: true,
      ownerHint: { feedId: "primary-work", cardId: "existing-mail-card" },
    });

    const card = await store.readCard("primary-work", "existing-mail-card");
    expect(card).toMatchObject({
      title: "Reply with the revised brief",
      commitmentId: recorded.commitment!.id,
      actions: [expect.objectContaining({ id: "prepare-reply", behavior: "queue_instruction" })],
    });
    expect(card.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "draft", type: "editable_text", value: "Here is the revised brief." }),
      expect.objectContaining({ id: "source-receipts", type: "receipt" }),
    ]));
  });

  test("splits and relinks one attributable signal without losing provenance", async () => {
    const { store, domain, primarySource, sideSource, primaryRun, sideRun } = await setup();
    const normalized = { promise: "Send the revised launch brief", deliverable: "Revised launch brief" };
    const first = await domain.recordCommitmentCandidate("primary-work", {
      sourceId: primarySource.id, sourceRunId: primaryRun, snapshotId: "snapshot-1", signalKind: "meeting_note",
      sourceSignalKey: "promise-1",
      deduplicationKey: "reversible-merge", explicitness: "explicit_first_person_bounded", certainty: 0.98,
      normalized, judgmentPolicyVersion: "commitment-v1", ...TEST_JUDGMENT, sourceClass: "meeting_notes", qualityGatePassed: true,
      ownerHint: { feedId: "primary-work" },
    });
    const second = await domain.recordCommitmentCandidate("side-project", {
      sourceId: sideSource.id, sourceRunId: sideRun, snapshotId: "snapshot-1", signalKind: "email",
      sourceSignalKey: "promise-2",
      deduplicationKey: "reversible-merge", explicitness: "explicit_first_person_bounded", certainty: 0.96,
      normalized, judgmentPolicyVersion: "commitment-v1", ...TEST_JUDGMENT, sourceClass: "email", qualityGatePassed: true,
      ownerHint: { feedId: "primary-work" },
    });
    expect(second.candidate.signal.candidateId).toBe(second.candidate.id);
    expect(second.commitment).toBeNull();
    await domain.confirmCommitmentCandidate(second.candidate.id, true);

    const split = await domain.splitCommitmentCandidate(second.candidate.id, {
      deduplicationKey: "revised-investor-brief",
      reason: "This follow-up concerns a distinct deliverable.",
    });
    expect(split.source).toMatchObject({ id: first.commitment!.id, signals: [first.candidate.signal] });
    expect(split.target.signals).toEqual([second.candidate.signal]);
    expect(split.candidate.commitmentId).toBe(split.target.id);
    expect((await store.listCommitmentEvents(split.source.id)).at(-1)).toMatchObject({ type: "split" });

    const replay = await domain.recordCommitmentCandidate("side-project", {
      sourceId: sideSource.id, sourceRunId: sideRun, snapshotId: "snapshot-1", signalKind: "email",
      sourceSignalKey: "promise-2",
      deduplicationKey: "reversible-merge", explicitness: "explicit_first_person_bounded", certainty: 0.96,
      normalized, judgmentPolicyVersion: "commitment-v1", ...TEST_JUDGMENT, sourceClass: "email", qualityGatePassed: true,
      ownerHint: { feedId: "primary-work" },
    });
    expect(replay.candidate.id).toBe(second.candidate.id);
    expect(replay.commitment?.id).toBe(split.target.id);

    const relinked = await domain.relinkCommitmentCandidate(second.candidate.id, first.commitment!.id, "The split was incorrect after reviewing both receipts.");
    expect(relinked.source).toMatchObject({ id: split.target.id, status: "superseded", signals: [] });
    expect(relinked.target.status).toBe("open");
    expect(relinked.target.signals.map((signal) => signal.id).sort()).toEqual([
      first.candidate.signal.id,
      second.candidate.signal.id,
    ].sort());
    const restoredCard = await store.readCard(relinked.target.owner.feedId, relinked.target.owner.cardId);
    expect(restoredCard.status).not.toBe("done");
    expect(restoredCard.completedAt).toBeUndefined();
    expect((await store.listCommitmentEvents(relinked.target.id)).at(-1)).toMatchObject({ type: "signal_relinked" });
  });

  test("refuses to empty a fulfilled commitment through split without a valid lifecycle transition", async () => {
    const { domain, primarySource, primaryRun } = await setup();
    const recorded = await domain.recordCommitmentCandidate("primary-work", {
      sourceId: primarySource.id,
      sourceRunId: primaryRun,
      snapshotId: "snapshot-1",
      signalKind: "meeting_note",
      deduplicationKey: "fulfilled-split-guard",
      explicitness: "explicit_first_person_bounded",
      certainty: 0.99,
      normalized: { promise: "Send the final launch brief" },
      judgmentPolicyVersion: "commitment-v1",
      ...TEST_JUDGMENT,
      sourceClass: "meeting_notes",
      qualityGatePassed: true,
      ownerHint: { feedId: "primary-work" },
    });
    await domain.transitionCommitment(recorded.commitment!.id, "fulfilled", "Delivery was verified.");

    await expect(domain.splitCommitmentCandidate(recorded.candidate.id, {
      deduplicationKey: "different-fulfilled-brief",
      reason: "Try to move the only receipt.",
    })).rejects.toThrow("cannot transition from fulfilled to superseded");
  });

  test("rehydrates the canonical index and event history from SQLite after restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tend-commitment-runtime-"));
    roots.push(root);
    const dataDir = path.join(root, "data");
    const dbPath = path.join(root, "attention.db");
    const first = await createLocalRuntime(dataDir, dbPath);
    let expectedCommitment;
    let expectedEvents;
    try {
      const domain = new AttentionDomain(first.store);
      await domain.createFeedFromBrief("Primary Work\nHandle primary work commitments.", null);
      const source = await domain.addSourceFromBrief("primary-work", "Read synthetic meeting notes.");
      const run = await domain.recordSourceRun("primary-work", source.id, [{ id: "note-1" }], [], { cursor: "note-1" });
      const recorded = await domain.recordCommitmentCandidate("primary-work", {
        sourceId: source.id,
        sourceRunId: run,
        snapshotId: "snapshot-1",
        signalKind: "meeting_note",
        deduplicationKey: "restart-proof",
        explicitness: "explicit_first_person_bounded",
        certainty: 0.99,
        normalized: { promise: "Send the restart proof" },
        judgmentPolicyVersion: "commitment-v1",
        ...TEST_JUDGMENT,
        sourceClass: "meeting_notes",
        qualityGatePassed: true,
        ownerHint: { feedId: "primary-work" },
      });
      expectedCommitment = recorded.commitment;
      expectedEvents = await first.store.listCommitmentEvents(recorded.commitment!.id);
    } finally {
      first.sqlite.close();
    }

    const restarted = await createLocalRuntime(dataDir, dbPath);
    try {
      expect(await restarted.store.readWorkspaceCommitment(expectedCommitment!.id)).toEqual(expectedCommitment);
      expect(await restarted.store.listCommitmentEvents(expectedCommitment!.id)).toEqual(expectedEvents);
    } finally {
      restarted.sqlite.close();
    }
  });
});
