import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { cp, lstat, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { attentionDataDir, attentionDbPath, attentionHome } from "../paths";
import { SQLITE_SCHEMA_VERSION } from "../sqlite";
import { configurePrivateProcessPermissions, ensurePrivateDirectory, hardenPrivateTree, PRIVATE_FILE_MODE, withMutationLock, withRuntimeReplacementLock } from "../util";
import { apiUrl, initRuntime, print } from "./shared";

export async function backupExportCommand(targetPath: string): Promise<void> {
  configurePrivateProcessPermissions();
  const target = path.resolve(targetPath);
  if (existsSync(target)) {
    throw new Error(`Backup target already exists: ${target}. Choose a new empty path.`);
  }
  if (isWithin(attentionDataDir(), target)) {
    throw new Error("Backup target cannot be inside Tend's data directory.");
  }

  await mkdir(path.dirname(target), { recursive: true });
  const stage = await mkdtemp(path.join(path.dirname(target), `.${path.basename(target)}-`));
  try {
    await withMutationLock(attentionDataDir(), async () => {
      const sqlite = await initRuntime();
      try {
        await sqlite.backupTo(path.join(stage, "attention.db"));
        await cp(attentionDataDir(), path.join(stage, "data"), { recursive: true });
        await rm(path.join(stage, "data", ".mutation-lock"), { recursive: true, force: true });
        await writeFile(path.join(stage, "manifest.json"), JSON.stringify({
          name: "tend-backup",
          format: 2,
          exportedAt: new Date().toISOString(),
          dataDir: attentionDataDir(),
          dbPath: attentionDbPath(),
        }, null, 2), { mode: PRIVATE_FILE_MODE });
        await hardenPrivateTree(stage);
        await rename(stage, target);
      } finally {
        sqlite.close();
      }
    });
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  print({ ok: true, exported: { dataDir: attentionDataDir(), dbPath: attentionDbPath() }, to: target });
}

export async function backupImportCommand(sourcePath: string): Promise<void> {
  configurePrivateProcessPermissions();
  const source = path.resolve(sourcePath);
  if (!existsSync(source)) throw new Error(`Backup path does not exist: ${source}`);
  await withRuntimeReplacementLock(attentionHome(), () => importStoppedRuntime(source));
}

async function importStoppedRuntime(source: string): Promise<void> {
  await assertRuntimeStopped();

  const bundledData = path.join(source, "data");
  const bundledDb = path.join(source, "attention.db");
  const sourceData = existsSync(bundledData) ? bundledData : source;
  if (!(await stat(sourceData)).isDirectory()) throw new Error(`Backup data is not a directory: ${sourceData}`);

  const home = path.resolve(attentionHome());
  await mkdir(path.dirname(home), { recursive: true });
  const stage = await mkdtemp(path.join(os.tmpdir(), "attention-import-"));
  const rollback = path.join(stage, "rollback");
  const stagedData = path.join(stage, "data");
  const stagedDb = path.join(stage, "attention.db");
  try {
    await cp(sourceData, stagedData, { recursive: true });
    await rm(path.join(stagedData, ".mutation-lock"), { recursive: true, force: true });
    if (existsSync(bundledDb)) {
      await cp(bundledDb, stagedDb);
      await assertRegularBackupFile(stagedDb);
      validateSqliteBackup(stagedDb);
      invalidateRuntimeReadiness(stagedDb);
    }
    await hardenPrivateTree(stagedData);
    if (existsSync(stagedDb)) await hardenPrivateTree(stagedDb);
    await ensurePrivateDirectory(home);
    await ensurePrivateDirectory(rollback);

    const currentFiles = [
      attentionDataDir(),
      attentionDbPath(),
      `${attentionDbPath()}-shm`,
      `${attentionDbPath()}-wal`,
    ];
    const moved: Array<{ from: string; to: string }> = [];
    try {
      for (const current of currentFiles) {
        if (!existsSync(current)) continue;
        const backup = path.join(rollback, path.basename(current));
        await rename(current, backup);
        moved.push({ from: backup, to: current });
      }
      await rename(stagedData, attentionDataDir());
      if (existsSync(stagedDb)) await rename(stagedDb, attentionDbPath());
      await hardenPrivateTree(home);
    } catch (error) {
      await rm(attentionDataDir(), { recursive: true, force: true });
      await removeSqliteFiles();
      for (const item of moved.reverse()) {
        if (existsSync(item.from)) await rename(item.from, item.to);
      }
      throw error;
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }

  print({
    ok: true,
    imported: source,
    to: {
      dataDir: attentionDataDir(),
      dbPath: attentionDbPath(),
      sqlite: existsSync(bundledDb) ? "restored" : "will_rehydrate_from_file_mirrors",
    },
  });
}

export async function assertRegularBackupFile(dbPath: string): Promise<void> {
  const metadata = await lstat(dbPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Backup attention.db must be a regular file, not a symbolic link or special file.");
  }
}

function invalidateRuntimeReadiness(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.query("INSERT INTO meta (key, value) VALUES ('runtime_state', 'incomplete') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  } finally {
    db.close();
  }
}

function validateSqliteBackup(dbPath: string): void {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query("PRAGMA integrity_check;").all() as Array<{ integrity_check: string }>;
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
      throw new Error(`Backup SQLite integrity check failed: ${rows.map((row) => row.integrity_check).join("; ") || "no result"}`);
    }
    let schemaRow: { value: string } | null;
    try {
      schemaRow = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null;
    } catch {
      throw new Error("Backup SQLite database is not a Tend runtime.");
    }
    const schemaVersion = Number(schemaRow?.value);
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
      throw new Error("Backup SQLite database is missing a valid Tend schema version.");
    }
    if (schemaVersion > SQLITE_SCHEMA_VERSION) {
      throw new Error(`Backup schema ${schemaVersion} is newer than this Tend build supports (${SQLITE_SCHEMA_VERSION}).`);
    }
  } finally {
    db.close();
  }
}

export async function assertRuntimeStopped(url = `${apiUrl()}/api/status`): Promise<void> {
  try {
    await probeLocalListener(url, 750);
    throw new Error("Stop Tend before importing a backup. A local service listener is still active.");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Stop Tend")) throw error;
    if (isConnectionRefused(error)) return;
    throw new Error(
      `Cannot verify that Tend is stopped; refusing backup import: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function probeLocalListener(url: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const probe = request(url, { method: "GET", agent: false }, (response) => {
      response.destroy();
      finish(resolve);
    });
    const timer = setTimeout(() => {
      const error = Object.assign(new Error(`Local Tend status probe timed out after ${timeoutMs}ms.`), { code: "ETIMEDOUT" });
      probe.destroy(error);
      finish(() => reject(error));
    }, timeoutMs);
    probe.on("error", (error) => finish(() => reject(error)));
    probe.end();
  });
}

function isConnectionRefused(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && (error as { code?: unknown }).code === "ECONNREFUSED") return true;
  if ("cause" in error && isConnectionRefused((error as { cause?: unknown }).cause)) return true;
  if (error instanceof AggregateError) return error.errors.some(isConnectionRefused);
  return false;
}

async function removeSqliteFiles(): Promise<void> {
  await Promise.all([
    rm(attentionDbPath(), { force: true }),
    rm(`${attentionDbPath()}-shm`, { force: true }),
    rm(`${attentionDbPath()}-wal`, { force: true }),
  ]);
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
