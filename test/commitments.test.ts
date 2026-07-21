import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { AttentionStore } from "../server/store";
import { createLocalRuntime } from "../server/runtime";

const roots: string[] = [];

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
        sourceClass: "email",
        qualityGatePassed: true,
        ownerHint: { feedId: "primary-work" },
      }),
    ]);

    expect(fromMeeting.commitment?.id).toBe(fromEmail.commitment?.id);
    const commitments = await store.listWorkspaceCommitments();
    expect(commitments).toHaveLength(1);
    expect(commitments[0].signals).toHaveLength(2);
    expect(commitments[0].owner.feedId).toBe("primary-work");
    expect(await store.hasCard("primary-work", commitments[0].owner.cardId)).toBe(true);
    expect((await store.readCard("primary-work", commitments[0].owner.cardId)).sourceRunIds).toBeUndefined();
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
      sourceClass: "meeting_notes",
      qualityGatePassed: true,
      ownerHint: { feedId: "primary-work" },
    });
    expect(ambiguous.candidate.status).toBe("pending_confirmation");
    expect(ambiguous.commitment).toBeNull();

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
      sourceClass: "meeting_notes",
      qualityGatePassed: false,
      ownerHint: { feedId: "primary-work" },
    });
    expect(gated.candidate.status).toBe("pending_confirmation");
    expect(await store.listWorkspaceCommitments()).toHaveLength(0);

    const accepted = await domain.confirmCommitmentCandidate(ambiguous.candidate.id, true);
    expect(accepted.commitment?.status).toBe("open");
    expect((await store.readCommitmentCandidate(ambiguous.candidate.id)).status).toBe("accepted");
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
