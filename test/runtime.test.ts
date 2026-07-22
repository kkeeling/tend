import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { attentionHome } from "../server/paths";
import { createLocalRuntime, resolveRuntimeRoot } from "../server/runtime";
import { LocalSqliteStore, SQLITE_SCHEMA_VERSION } from "../server/sqlite";

describe("runtime resolution", () => {
  test("uses the same default home for source and packaged entrypoints", () => {
    const previous = process.env.ATTENTION_HOME;
    delete process.env.ATTENTION_HOME;
    try {
      expect(resolveRuntimeRoot("/tmp/tend-source")).toBe(attentionHome());
      expect(resolveRuntimeRoot("/tmp/tend-binary")).toBe(attentionHome());
    } finally {
      if (previous === undefined) delete process.env.ATTENTION_HOME;
      else process.env.ATTENTION_HOME = previous;
    }
  });

  test("honors an explicit isolated runtime", () => {
    const previous = process.env.ATTENTION_HOME;
    process.env.ATTENTION_HOME = "/tmp/attention-isolated";
    try {
      expect(resolveRuntimeRoot("/tmp/attention-worktree")).toBe("/tmp/attention-isolated");
    } finally {
      if (previous === undefined) delete process.env.ATTENTION_HOME;
      else process.env.ATTENTION_HOME = previous;
    }
  });

  test("refuses a runtime created by a newer schema", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "attention-newer-schema-"));
    const dbPath = path.join(root, "attention.db");
    const newer = new Database(dbPath, { create: true });
    newer.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    newer.query("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SQLITE_SCHEMA_VERSION + 1));
    newer.close();

    const sqlite = new LocalSqliteStore(dbPath);
    try {
      await expect(sqlite.init()).rejects.toThrow("newer than this Tend build supports");
      const unchanged = new Database(dbPath);
      expect(unchanged.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
        value: String(SQLITE_SCHEMA_VERSION + 1),
      });
      unchanged.close();
    } finally {
      sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("migrates feed-scoped primary keys without losing legacy cards", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "attention-runtime-schema-"));
    const dbPath = path.join(root, "attention.db");
    const legacy = new Database(dbPath, { create: true });
    legacy.exec(`
      CREATE TABLE cards (
        id TEXT PRIMARY KEY,
        feed_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        ready_for_pass INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      INSERT INTO cards (
        id, feed_id, kind, status, ready_for_pass, created_at, updated_at, payload_json
      ) VALUES (
        'legacy-card',
        'inbox',
        'attention',
        'to_review_new',
        0,
        '2026-06-13T18:00:00.000Z',
        '2026-06-13T18:00:00.000Z',
        '{"id":"legacy-card","feedId":"inbox"}'
      );
    `);
    legacy.close();

    const runtime = await createLocalRuntime(path.join(root, "data"), dbPath);
    try {
      expect(await runtime.store.hasCard("inbox", "legacy-card")).toBe(true);
      const domain = new AttentionDomain(runtime.store);
      await domain.createFeedFromBrief("Every\nReview Every.", null);
      await domain.upsertCard("inbox", {
        id: "shared-card",
        title: "Inbox card",
        why: "Inbox context.",
        blocks: [{ id: "memo", type: "memo", text: "Inbox." }],
      });
      await domain.upsertCard("every", {
        id: "shared-card",
        title: "Every card",
        why: "Every context.",
        blocks: [{ id: "memo", type: "memo", text: "Every." }],
      });

      expect((await runtime.store.readCard("inbox", "shared-card")).title).toBe("Inbox card");
      expect((await runtime.store.readCard("every", "shared-card")).title).toBe("Every card");

      const feedback = await domain.submitVoiceInstruction(
        "inbox",
        { kind: "card", feedId: "inbox", cardId: "shared-card" },
        "This migrated card still accepts feedback.",
      );
      expect(feedback.work.status).toBe("queued");
      expect((await runtime.store.readCard("inbox", "shared-card")).history).toEqual([
        expect.objectContaining({
          type: "user.scoped_instruction",
          detail: "This migrated card still accepts feedback.",
        }),
      ]);
      const feedbackEventTypes = (await runtime.store.readEvents("inbox"))
        .filter((event) => event.workId === feedback.work.id)
        .map((event) => event.type);
      expect(feedbackEventTypes).toHaveLength(2);
      expect(feedbackEventTypes).toEqual(expect.arrayContaining([
        "voice.intent_queued",
        "voice.instruction_submitted",
      ]));
    } finally {
      runtime.sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not publish or resurrect filesystem mirrors from a rolled-back workspace transaction", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "attention-runtime-atomic-mirror-"));
    const dataDir = path.join(root, "data");
    const dbPath = path.join(root, "attention.db");
    const commitment = {
      id: "commitment-rolled-back",
      version: 1,
      deduplicationKey: "rolled-back",
      owner: { feedId: "inbox", cardId: "rolled-back-card" },
      promise: "This commitment must not survive rollback",
      certainty: 0.99,
      status: "open" as const,
      priorityContext: { domain: "inbox", consequence: "medium" as const },
      signals: [],
      createdAt: "2026-07-22T12:00:00.000Z",
      updatedAt: "2026-07-22T12:00:00.000Z",
    };
    const first = await createLocalRuntime(dataDir, dbPath);
    try {
      await expect(first.store.serializeAtomic(async () => {
        await first.store.writeWorkspaceCommitment(commitment);
        throw new Error("interrupt after authoritative write");
      })).rejects.toThrow("interrupt after authoritative write");
      expect(await first.store.listWorkspaceCommitments()).toEqual([]);
      expect(existsSync(path.join(dataDir, "workspace", "commitments", `${commitment.id}.json`))).toBe(false);
    } finally {
      first.sqlite.close();
    }

    const restarted = await createLocalRuntime(dataDir, dbPath);
    try {
      expect(await restarted.store.listWorkspaceCommitments()).toEqual([]);
    } finally {
      restarted.sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rolls back a source run, checkpoint, and receipt as one authoritative transaction", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "attention-runtime-source-atomic-"));
    const dataDir = path.join(root, "data");
    const dbPath = path.join(root, "attention.db");
    const runtime = await createLocalRuntime(dataDir, dbPath);
    const source = {
      id: "atomic-source",
      name: "Atomic source",
      filename: "atomic-source.md",
      checkpointFilename: "atomic-source.json",
      summary: "Synthetic atomic source.",
    };
    try {
      await runtime.store.addSource("inbox", source, "# Atomic source\n");
      const before = await runtime.store.readSourceCheckpoint("inbox", source.id);
      await expect(runtime.store.serializeAtomic(async () => {
        await runtime.store.writeRun({
          id: "run-rolled-back",
          feedId: "inbox",
          sourceId: source.id,
          snapshots: 1,
          judgments: [],
          completedAt: "2026-07-22T12:00:00.000Z",
        });
        await runtime.store.writeSourceCheckpoint("inbox", source.id, { cursor: "must-not-advance" });
        await runtime.store.appendSourceAttempt({
          id: "attempt-rolled-back",
          feedId: "inbox",
          sourceId: source.id,
          outcome: "success",
          startedAt: "2026-07-22T11:59:00.000Z",
          completedAt: "2026-07-22T12:00:00.000Z",
          observedIdentity: { account: "synthetic-account" },
          completeness: { identityVerified: true, scopeVerified: true, permissionsComplete: true, paginationComplete: true, backfillComplete: true },
          runId: "run-rolled-back",
          checkpointAdvanced: true,
        });
        throw new Error("interrupt source transaction");
      })).rejects.toThrow("interrupt source transaction");
      await expect(runtime.store.readRun("inbox", "run-rolled-back")).rejects.toThrow();
      expect(await runtime.store.readSourceCheckpoint("inbox", source.id)).toEqual(before);
      expect(await runtime.store.listSourceAttempts("inbox", source.id)).toEqual([]);
      expect(existsSync(path.join(dataDir, "feeds", "inbox", "runs", "run-rolled-back.json"))).toBe(false);
    } finally {
      runtime.sqlite.close();
    }

    const restarted = await createLocalRuntime(dataDir, dbPath);
    try {
      await expect(restarted.store.readRun("inbox", "run-rolled-back")).rejects.toThrow();
      expect(await restarted.store.listSourceAttempts("inbox", source.id)).toEqual([]);
    } finally {
      restarted.sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
