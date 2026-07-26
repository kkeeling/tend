import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalRuntime } from "../server/runtime";

test("status, doctor, and backup export bootstrap a fresh maintenance runtime", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "tend-maintenance-fresh-"));
  const backup = path.join(path.dirname(home), `${path.basename(home)}-backup`);
  try {
    const status = await run(home, ["status"]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout).sqlite.ready).toBe(true);

    const doctor = await run(home, ["doctor"]);
    expect(doctor.exitCode).toBe(0);
    expect(JSON.parse(doctor.stdout).checks).toBeArray();

    const exported = await run(home, ["backup", "export", backup]);
    expect(exported.exitCode).toBe(0);
    expect(existsSync(path.join(backup, "attention.db"))).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
  }
}, 15_000);

test("maintenance commands repair a pre-marker schema-17 runtime", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "tend-maintenance-legacy-"));
  const dbPath = path.join(home, "attention.db");
  try {
    const runtime = await createLocalRuntime(path.join(home, "data"), dbPath);
    runtime.sqlite.close();
    const database = new Database(dbPath);
    database.query("DELETE FROM meta WHERE key IN ('runtime_state', 'bootstrap_generation')").run();
    database.close();

    const status = await run(home, ["status"]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout).sqlite.ready).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function run(home: string, args: string[]) {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, "tend.ts", ...args],
    cwd: process.cwd(),
    env: {
      ...process.env,
      ATTENTION_API_PORT: "0",
      ATTENTION_HOME: home,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return { stdout, stderr, exitCode };
}
