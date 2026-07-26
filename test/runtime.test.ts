import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { attentionHome } from "../server/paths";
import { createLocalRuntime, openOrBootstrapLocalRuntime, resolveRuntimeRoot } from "../server/runtime";
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

  test("fast open requires a completed bootstrap and does not churn runtime metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "attention-runtime-fast-open-"));
    const dataDir = path.join(root, "data");
    const dbPath = path.join(root, "attention.db");
    try {
      await expect(createLocalRuntime(dataDir, dbPath, { mode: "fast" }))
        .rejects.toThrow("has not completed bootstrap");

      const bootstrapped = await createLocalRuntime(dataDir, dbPath);
      const initialStatus = bootstrapped.sqlite.status();
      expect(initialStatus.ready).toBe(true);
      bootstrapped.sqlite.close();

      await Bun.sleep(5);
      const reopened = await createLocalRuntime(dataDir, dbPath, { mode: "fast" });
      try {
        expect(reopened.sqlite.status()).toEqual(initialStatus);
        expect(await reopened.store.listFeedIds()).toContain("inbox");
      } finally {
        reopened.sqlite.close({ checkpoint: false });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("warm workspace reads do not modify SQLite metadata or projection mirrors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "attention-runtime-pure-read-"));
    const dataDir = path.join(root, "data");
    const dbPath = path.join(root, "attention.db");
    const bootstrapped = await createLocalRuntime(dataDir, dbPath);
    bootstrapped.sqlite.close();
    const projectionPath = path.join(dataDir, "workspace", "now-projection.json");
    const beforeDb = await stat(dbPath);
    const beforeProjection = await stat(projectionPath);
    const runtime = await createLocalRuntime(dataDir, dbPath, { mode: "fast" });
    const beforeStatus = runtime.sqlite.status();
    try {
      await runtime.store.readWorkspaceNow();
      await runtime.store.readWorkspaceCoverage();
      await runtime.store.readWorkspacePriority();
      expect(runtime.sqlite.status()).toEqual(beforeStatus);
    } finally {
      runtime.sqlite.close({ checkpoint: false });
    }
    const afterDb = await stat(dbPath);
    const afterProjection = await stat(projectionPath);
    expect(afterDb.mtimeMs).toBe(beforeDb.mtimeMs);
    expect(afterProjection.mtimeMs).toBe(beforeProjection.mtimeMs);
    await rm(root, { recursive: true, force: true });
  });

  test("service open bootstraps once and then preserves ready runtime metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "attention-runtime-service-open-"));
    const dataDir = path.join(root, "data");
    const dbPath = path.join(root, "attention.db");
    try {
      const first = await openOrBootstrapLocalRuntime(dataDir, dbPath);
      const firstStatus = first.sqlite.status();
      first.sqlite.close();

      await Bun.sleep(5);
      const reopened = await openOrBootstrapLocalRuntime(dataDir, dbPath);
      expect(reopened.sqlite.status()).toEqual(firstStatus);
      reopened.sqlite.close({ checkpoint: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("service open rehydrates filesystem mirrors when the SQLite database is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "attention-runtime-mirror-rehydrate-"));
    const dataDir = path.join(root, "data");
    const dbPath = path.join(root, "attention.db");
    try {
      const initial = await createLocalRuntime(dataDir, dbPath);
      await new AttentionDomain(initial.store).upsertCard("inbox", {
        id: "mirror-only-card",
        title: "Restore this card",
        why: "The filesystem mirror is the recovery source when SQLite is missing.",
        blocks: [],
      });
      initial.sqlite.close();
      await Promise.all([
        rm(dbPath, { force: true }),
        rm(`${dbPath}-shm`, { force: true }),
        rm(`${dbPath}-wal`, { force: true }),
      ]);

      const restored = await openOrBootstrapLocalRuntime(dataDir, dbPath);
      try {
        expect(await restored.store.hasCard("inbox", "mirror-only-card")).toBe(true);
        expect((await restored.store.readCard("inbox", "mirror-only-card")).title).toBe("Restore this card");
      } finally {
        restored.sqlite.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("SQLite generations commit atomically with priority and feed-event state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "attention-runtime-generations-"));
    const dataDir = path.join(root, "data");
    const dbPath = path.join(root, "attention.db");
    const runtime = await createLocalRuntime(dataDir, dbPath);
    runtime.sqlite.close();
    const database = new Database(dbPath);
    try {
      const priorityBefore = database.query("SELECT value FROM meta WHERE key = 'priority_schedule_generation'").get() as { value: string } | null;
      const feedBefore = database.query("SELECT value FROM meta WHERE key = 'feed_event_generation:inbox'").get() as { value: string } | null;
      database.exec("BEGIN");
      database.query(`
        INSERT INTO cards (feed_id, id, kind, status, ready_for_pass, created_at, updated_at, payload_json)
        VALUES ('inbox', 'rolled-back', 'attention', 'to_review_new', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z', '{}')
      `).run();
      database.exec("ROLLBACK");
      expect(database.query("SELECT 1 AS found FROM cards WHERE id = 'rolled-back'").get()).toBeNull();
      expect(database.query("SELECT value FROM meta WHERE key = 'priority_schedule_generation'").get()).toEqual(priorityBefore);

      database.query(`
        INSERT INTO cards (feed_id, id, kind, status, ready_for_pass, created_at, updated_at, payload_json)
        VALUES ('inbox', 'committed', 'attention', 'to_review_new', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z', '{}')
      `).run();
      expect(database.query("SELECT value FROM meta WHERE key = 'priority_schedule_generation'").get()).not.toEqual(priorityBefore);

      database.exec("BEGIN");
      database.query(`
        INSERT INTO feed_events (event_order, id, feed_id, type, at)
        VALUES (900001, 'rolled-back-event', 'inbox', 'test', '2026-07-26T00:00:00.000Z')
      `).run();
      database.exec("ROLLBACK");
      expect(database.query("SELECT value FROM meta WHERE key = 'feed_event_generation:inbox'").get()).toEqual(feedBefore);
      database.query(`
        INSERT INTO feed_events (event_order, id, feed_id, type, at)
        VALUES (900002, 'committed-event', 'inbox', 'test', '2026-07-26T00:00:00.000Z')
      `).run();
      expect(database.query("SELECT value FROM meta WHERE key = 'feed_event_generation:inbox'").get()).not.toEqual(feedBefore);
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("service open repairs legacy 0755 runtime directory modes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "attention-runtime-service-permissions-"));
    const dataDir = path.join(root, "data");
    const dbPath = path.join(root, "attention.db");
    try {
      const initial = await createLocalRuntime(dataDir, dbPath);
      initial.sqlite.close();
      await chmod(root, 0o755);
      await chmod(dataDir, 0o755);

      const repaired = await openOrBootstrapLocalRuntime(dataDir, dbPath);
      repaired.sqlite.close();
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
    } finally {
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
      const generationBeforeCardWrite = await runtime.store.readPriorityScheduleCursor();
      await domain.upsertCard("inbox", {
        id: "shared-card",
        title: "Inbox card",
        why: "Inbox context.",
        blocks: [{ id: "memo", type: "memo", text: "Inbox." }],
      });
      expect(await runtime.store.readPriorityScheduleCursor()).not.toBe(generationBeforeCardWrite);
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

  test("repair rewrites stale mutable mirrors and removes mirror-only workspace records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "attention-runtime-mirror-repair-"));
    const dataDir = path.join(root, "data");
    const dbPath = path.join(root, "attention.db");
    const commitment = {
      id: "commitment-repair",
      version: 1,
      deduplicationKey: "repair",
      owner: { feedId: "inbox", cardId: "repair-card" },
      promise: "Filesystem mirror version one",
      certainty: 0.99,
      status: "open" as const,
      priorityContext: { domain: "inbox", consequence: "medium" as const },
      signals: [],
      createdAt: "2026-07-22T12:00:00.000Z",
      updatedAt: "2026-07-22T12:00:00.000Z",
    };
    const mirrorPath = path.join(dataDir, "workspace", "commitments", `${commitment.id}.json`);
    const extraMirrorPath = path.join(dataDir, "workspace", "commitments", "mirror-only.json");
    const initial = await createLocalRuntime(dataDir, dbPath);
    await initial.store.writeWorkspaceCommitment(commitment);
    initial.sqlite.close();

    const authoritative = {
      ...commitment,
      version: 2,
      promise: "SQLite authoritative version two",
      updatedAt: "2026-07-22T13:00:00.000Z",
    };
    const database = new Database(dbPath);
    database.query(`
      UPDATE workspace_commitments
      SET version = ?, updated_at = ?, payload_json = ?
      WHERE id = ?
    `).run(authoritative.version, authoritative.updatedAt, JSON.stringify(authoritative), authoritative.id);
    database.query("UPDATE meta SET value = '1' WHERE key = 'mirror_repair_required'").run();
    database.close();
    await mkdir(path.dirname(extraMirrorPath), { recursive: true });
    await writeFile(extraMirrorPath, `${JSON.stringify({
      ...commitment,
      id: "mirror-only",
      deduplicationKey: "mirror-only",
    })}\n`);

    const repaired = await openOrBootstrapLocalRuntime(dataDir, dbPath);
    try {
      expect((await repaired.store.readWorkspaceCommitment(commitment.id)).promise).toBe(authoritative.promise);
      expect(JSON.parse(await readFile(mirrorPath, "utf8"))).toEqual(authoritative);
      expect(existsSync(extraMirrorPath)).toBe(false);
      expect(repaired.sqlite.status().mirrorRepairRequired).toBe(false);
    } finally {
      repaired.sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("two runtimes sharing one home preserve one work capability token", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "attention-runtime-cross-process-claim-"));
    const dataDir = path.join(root, "data");
    const dbPath = path.join(root, "attention.db");
    const first = await createLocalRuntime(dataDir, dbPath);
    const firstDomain = new AttentionDomain(first.store);
    await firstDomain.bindFeed("inbox", "thread-inbox");
    await firstDomain.upsertCard("inbox", {
      id: "claim-once",
      title: "Claim exactly once",
      why: "Concurrent runtimes must share the filesystem mutation lock.",
      blocks: [],
    });
    const queued = await firstDomain.queueInstruction("inbox", "claim-once", "Inspect this once.");
    const second = await createLocalRuntime(dataDir, dbPath, { mode: "fast" });
    const secondDomain = new AttentionDomain(second.store);
    try {
      const claims = await Promise.all([
        firstDomain.claimWork("inbox", "thread-inbox", false, "session-one"),
        secondDomain.claimWork("inbox", "thread-inbox", false, "session-two"),
      ]);
      const tokens = claims.flatMap((claim) =>
        claim && "capabilityToken" in claim && typeof claim.capabilityToken === "string"
          ? [claim.capabilityToken]
          : []);
      expect(tokens).toHaveLength(2);
      expect(new Set(tokens).size).toBe(1);
      expect((await first.store.readWork("inbox", queued.id)).capabilityToken).toBe(tokens[0]);
    } finally {
      second.sqlite.close({ checkpoint: false });
      first.sqlite.close();
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
