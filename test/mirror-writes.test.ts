import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MirrorWriteCoordinator } from "../server/repositories/mirrorWrites";
import { createLocalRuntime, openOrBootstrapLocalRuntime } from "../server/runtime";
import { AttentionDomain } from "../server/domain";

test("direct and transactional mirror failures record repair without reversing committed work", async () => {
  const failures: unknown[] = [];
  const coordinator = new MirrorWriteCoordinator((error) => failures.push(error));

  await expect(coordinator.write(async () => {
    throw new Error("direct mirror failure");
  })).resolves.toBeUndefined();
  await expect(coordinator.transaction(async () => {
    await coordinator.write(async () => {
      throw new Error("transactional mirror failure");
    });
    return "sqlite committed";
  })).resolves.toBe("sqlite committed");

  expect(coordinator.hasFailures()).toBe(true);
  expect(failures).toHaveLength(2);
});

test("a persisted mirror-repair marker forces bootstrap repair before fast service open", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-mirror-repair-"));
  const dataDir = path.join(root, "data");
  const dbPath = path.join(root, "attention.db");
  try {
    const runtime = await createLocalRuntime(dataDir, dbPath);
    runtime.sqlite.markMirrorRepairRequired();
    runtime.sqlite.close();

    const repaired = await openOrBootstrapLocalRuntime(dataDir, dbPath);
    expect(repaired.sqlite.status().mirrorRepairRequired).toBe(false);
    repaired.sqlite.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mirror repair keeps a valid SQLite deletion authoritative", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-mirror-delete-repair-"));
  const dataDir = path.join(root, "data");
  const dbPath = path.join(root, "attention.db");
  const cardId = "deleted-authoritatively";
  const mirrorPath = path.join(dataDir, "feeds", "company-attention", "cards", `${cardId}.json`);
  try {
    const runtime = await createLocalRuntime(dataDir, dbPath);
    await new AttentionDomain(runtime.store).upsertCard("company-attention", {
      id: cardId,
      title: "Delete me",
      why: "The mirror deletion will be replayed by repair.",
      blocks: [],
    });
    expect(existsSync(mirrorPath)).toBe(true);
    runtime.sqlite.close();

    const database = new Database(dbPath);
    database.query("DELETE FROM cards WHERE feed_id = ? AND id = ?").run("company-attention", cardId);
    database.query("INSERT INTO meta (key, value) VALUES ('mirror_repair_required', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    database.close();

    const repaired = await openOrBootstrapLocalRuntime(dataDir, dbPath);
    expect(await repaired.store.hasCard("company-attention", cardId)).toBe(false);
    expect(existsSync(mirrorPath)).toBe(false);
    expect(repaired.sqlite.status().mirrorRepairRequired).toBe(false);
    repaired.sqlite.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
