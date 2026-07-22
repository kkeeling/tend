import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalRuntime } from "../server/runtime";
import { appendPrivateText, hardenPrivateTree, writeJson, writeText } from "../server/util";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("private runtime permissions", () => {
  test("hardens existing state and keeps atomic and append writes owner-only", async () => {
    const root = await temporaryRoot();
    const nested = path.join(root, "nested");
    const existing = path.join(nested, "existing.json");
    await mkdir(nested, { mode: 0o755 });
    await writeFile(existing, "{}\n", { mode: 0o644 });

    await hardenPrivateTree(root);
    await writeJson(path.join(nested, "record.json"), { private: true });
    await writeText(path.join(nested, "note.md"), "private");
    await appendPrivateText(path.join(nested, "ledger.jsonl"), "{\"private\":true}\n");

    await expect(mode(root)).resolves.toBe(0o700);
    await expect(mode(nested)).resolves.toBe(0o700);
    for (const file of [existing, "record.json", "note.md", "ledger.jsonl"].map((name) => path.isAbsolute(name) ? name : path.join(nested, name))) {
      await expect(mode(file)).resolves.toBe(0o600);
    }
  });

  test("a local runtime repairs legacy modes and creates no group-readable files", async () => {
    const root = await temporaryRoot();
    const dataDir = path.join(root, "data");
    const dbPath = path.join(root, "attention.db");
    await mkdir(dataDir, { mode: 0o755 });
    await writeFile(path.join(dataDir, "legacy.json"), "{}\n", { mode: 0o644 });

    const runtime = await createLocalRuntime(dataDir, dbPath);
    try {
      expect(await insecurePaths(root)).toEqual([]);
    } finally {
      runtime.sqlite.close();
    }
  });

  test("refuses symlinks instead of changing files outside private state", async () => {
    const root = await temporaryRoot();
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside`);
    roots.push(outside);
    await writeFile(outside, "outside\n", { mode: 0o644 });
    await chmod(outside, 0o644);
    await symlink(outside, path.join(root, "escape"));

    await expect(hardenPrivateTree(root)).rejects.toThrow("symbolic link inside private Tend state");
    expect(await mode(outside)).toBe(0o644);
    expect(await readFile(outside, "utf8")).toBe("outside\n");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-private-runtime-"));
  roots.push(root);
  return root;
}

async function mode(target: string): Promise<number> {
  return (await stat(target)).mode & 0o777;
}

async function insecurePaths(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(target: string): Promise<void> {
    const metadata = await lstat(target);
    const expected = metadata.isDirectory() ? 0o700 : 0o600;
    if (!metadata.isSymbolicLink() && (metadata.mode & 0o777) !== expected) output.push(path.relative(root, target) || ".");
    if (metadata.isDirectory()) {
      for (const entry of await readdir(target)) await visit(path.join(target, entry));
    }
  }
  await visit(root);
  return output;
}
