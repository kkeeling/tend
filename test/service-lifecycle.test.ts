import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireRuntimeReplacementLock } from "../server/util";

describe("foreground service lifecycle", () => {
  test("an occupied port fails before workers start and the process exits promptly", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test port.");
    const home = await mkdtemp(path.join(os.tmpdir(), "tend-occupied-port-"));
    const child = Bun.spawn({
      cmd: [process.execPath, "server.ts"],
      cwd: process.cwd(),
      env: {
        ...process.env,
        ATTENTION_API_PORT: String(address.port),
        ATTENTION_AUTODRAIN: "0",
        ATTENTION_HOME: home,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeout = Symbol("timeout");
    const startedAt = performance.now();
    try {
      const result = await Promise.race([
        child.exited,
        Bun.sleep(1_000).then(() => timeout),
      ]);
      if (result === timeout) {
        child.kill("SIGTERM");
        await child.exited;
      }
      expect(result).not.toBe(timeout);
      expect(result).not.toBe(0);
      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(existsSync(path.join(home, "attention.db"))).toBe(false);
      expect(existsSync(path.join(home, "data"))).toBe(false);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  }, 5_000);

  test("two concurrent starts have one listener owner and one healthy runtime", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test port.");
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const home = await mkdtemp(path.join(os.tmpdir(), "tend-concurrent-start-"));
    const spawn = () => Bun.spawn({
      cmd: [process.execPath, "server.ts"],
      cwd: process.cwd(),
      env: {
        ...process.env,
        ATTENTION_API_PORT: String(address.port),
        ATTENTION_AUTODRAIN: "0",
        ATTENTION_HOME: home,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const first = spawn();
    const second = spawn();
    const timeout = Symbol("timeout");
    try {
      const firstExit = first.exited.then((exitCode) => ({ process: first, other: second, exitCode }));
      const secondExit = second.exited.then((exitCode) => ({ process: second, other: first, exitCode }));
      const loser = await Promise.race([
        firstExit,
        secondExit,
        Bun.sleep(2_000).then(() => timeout),
      ]);
      if (loser === timeout) throw new Error("Neither concurrent Tend start yielded the port.");
      expect(loser.exitCode).not.toBe(0);

      let healthy = false;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          const response = await fetch(`http://127.0.0.1:${address.port}/api/status`);
          if (response.ok) {
            healthy = true;
            break;
          }
        } catch {
          // The winning listener may still be serving its bounded startup response.
        }
        await Bun.sleep(25);
      }
      expect(healthy).toBe(true);
      expect(existsSync(path.join(home, "attention.db"))).toBe(true);
      loser.other.kill("SIGTERM");
      await loser.other.exited;
    } finally {
      first.kill("SIGTERM");
      second.kill("SIGTERM");
      await Promise.all([first.exited, second.exited]);
      await rm(home, { recursive: true, force: true });
    }
  }, 8_000);

  test("foreground startup binds before a replacement wait so a duplicate fails promptly", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test port.");
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const home = await mkdtemp(path.join(os.tmpdir(), "tend-replacement-lock-"));
    const release = await acquireRuntimeReplacementLock(home);
    const child = Bun.spawn({
      cmd: [process.execPath, "server.ts"],
      cwd: process.cwd(),
      env: {
        ...process.env,
        ATTENTION_API_PORT: String(address.port),
        ATTENTION_AUTODRAIN: "0",
        ATTENTION_HOME: home,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    let duplicate: ReturnType<typeof Bun.spawn> | null = null;
    try {
      let startupVisible = false;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          if ((await fetch(`http://127.0.0.1:${address.port}/api/status`)).status === 503) {
            startupVisible = true;
            break;
          }
        } catch {
          // The first process has not bound yet.
        }
        await Bun.sleep(10);
      }
      expect(startupVisible).toBe(true);
      duplicate = Bun.spawn({
        cmd: [process.execPath, "server.ts"],
        cwd: process.cwd(),
        env: {
          ...process.env,
          ATTENTION_API_PORT: String(address.port),
          ATTENTION_AUTODRAIN: "0",
          ATTENTION_HOME: home,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const duplicateStartedAt = performance.now();
      expect(await duplicate.exited).not.toBe(0);
      expect(performance.now() - duplicateStartedAt).toBeLessThan(1_000);
      await release();
      let healthy = false;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          const response = await fetch(`http://127.0.0.1:${address.port}/api/status`);
          if (response.ok) {
            healthy = true;
            break;
          }
        } catch {
          // Startup may still be bootstrapping the imported runtime.
        }
        await Bun.sleep(25);
      }
      expect(healthy).toBe(true);
    } finally {
      await release();
      duplicate?.kill("SIGTERM");
      child.kill("SIGTERM");
      await child.exited;
      await rm(home, { recursive: true, force: true });
    }
  }, 8_000);

  test("a dead replacement-lock owner is quarantined and cannot wedge future starts", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "tend-stale-replacement-lock-"));
    const lockPath = `${home}.replacement-lock`;
    const stalePath = `${lockPath}.stale-dead-owner`;
    const exited = Bun.spawn(["/bin/sh", "-c", "exit 0"]);
    await exited.exited;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
        token: "dead-owner",
        pid: exited.pid,
        acquiredAt: "2026-07-26T00:00:00.000Z",
        runtimeRoot: home,
      })}\n`, { mode: 0o600 });

      const release = await acquireRuntimeReplacementLock(home);
      expect(existsSync(stalePath)).toBe(true);
      expect(existsSync(lockPath)).toBe(true);
      await release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await Promise.all([
        rm(home, { recursive: true, force: true }),
        rm(lockPath, { recursive: true, force: true }),
        rm(stalePath, { recursive: true, force: true }),
      ]);
    }
  });

  test("replacement-lock ownership is published atomically under contention", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "tend-atomic-replacement-lock-"));
    const lockPath = `${home}.replacement-lock`;
    const releaseFirst = await acquireRuntimeReplacementLock(home);
    let secondAcquired = false;
    const second = acquireRuntimeReplacementLock(home).then((release) => {
      secondAcquired = true;
      return release;
    });
    try {
      const published = JSON.parse(await readFile(lockPath, "utf8")) as {
        token?: string;
        pid?: number;
        runtimeRoot?: string;
      };
      expect(published.token).toBeTruthy();
      expect(published.pid).toBe(process.pid);
      expect(published.runtimeRoot).toBe(home);
      await Bun.sleep(40);
      expect(secondAcquired).toBe(false);

      await releaseFirst();
      const releaseSecond = await second;
      expect(secondAcquired).toBe(true);
      expect(JSON.parse(await readFile(lockPath, "utf8")).token).toBeTruthy();
      await releaseSecond();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await releaseFirst();
      await rm(lockPath, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("SIGTERM during bootstrap releases the owned replacement lock", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test port.");
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const home = await mkdtemp(path.join(os.tmpdir(), "tend-startup-signal-"));
    const padding = path.join(home, "data", "startup-padding");
    await mkdir(padding, { recursive: true, mode: 0o700 });
    for (let offset = 0; offset < 2_500; offset += 250) {
      await Promise.all(Array.from({ length: 250 }, (_unused, index) =>
        writeFile(path.join(padding, `${offset + index}.txt`), "padding", { mode: 0o600 })));
    }
    const child = Bun.spawn({
      cmd: [process.execPath, "server.ts"],
      cwd: process.cwd(),
      env: {
        ...process.env,
        ATTENTION_API_PORT: String(address.port),
        ATTENTION_AUTODRAIN: "0",
        ATTENTION_HOME: home,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      let sawStartupResponse = false;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        try {
          const response = await fetch(`http://127.0.0.1:${address.port}/api/status`);
          if (response.status === 503) {
            sawStartupResponse = true;
            break;
          }
          if (response.ok) break;
        } catch {
          // The listener has not bound yet.
        }
        await Bun.sleep(5);
      }
      expect(sawStartupResponse).toBe(true);
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      expect(existsSync(`${home}.replacement-lock`)).toBe(false);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
      await Promise.all([
        rm(home, { recursive: true, force: true }),
        rm(`${home}.replacement-lock`, { recursive: true, force: true }),
      ]);
    }
  }, 15_000);
});
