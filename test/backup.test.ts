import { describe, expect, test } from "bun:test";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertRuntimeStopped, backupImportCommand } from "../server/cli/backup";

describe("backup import file safety", () => {
  test("the full import path rejects a SQLite symlink before opening or mutating its target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tend-backup-symlink-"));
    const target = path.join(root, "outside.db");
    const backup = path.join(root, "backup");
    const home = path.join(root, "runtime");
    const previousHome = process.env.ATTENTION_HOME;
    const previousPort = process.env.ATTENTION_API_PORT;
    try {
      await mkdir(path.join(backup, "data"), { recursive: true });
      await writeFile(target, "unchanged");
      await symlink(target, path.join(backup, "attention.db"));
      process.env.ATTENTION_HOME = home;
      process.env.ATTENTION_API_PORT = "59999";
      await expect(backupImportCommand(backup)).rejects.toThrow("must be a regular file");
      expect(await Bun.file(target).text()).toBe("unchanged");
      expect(await Bun.file(path.join(home, "attention.db")).exists()).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.ATTENTION_HOME;
      else process.env.ATTENTION_HOME = previousHome;
      if (previousPort === undefined) delete process.env.ATTENTION_API_PORT;
      else process.env.ATTENTION_API_PORT = previousPort;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stopped-runtime verification rejects startup responses and transport uncertainty", async () => {
    const startupServer = createHttpServer((_request, response) => {
      response.statusCode = 503;
      response.end('{"error":"Tend is starting."}');
    });
    await new Promise<void>((resolve) => startupServer.listen(0, "127.0.0.1", resolve));
    const startupAddress = startupServer.address();
    if (!startupAddress || typeof startupAddress === "string") throw new Error("Expected an HTTP test port.");
    try {
      await expect(assertRuntimeStopped(`http://127.0.0.1:${startupAddress.port}/api/status`))
        .rejects.toThrow("Stop Tend before importing");
    } finally {
      await new Promise<void>((resolve) => startupServer.close(() => resolve()));
    }

    const sockets = new Set<import("node:net").Socket>();
    const stalledServer = createNetServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => stalledServer.listen(0, "127.0.0.1", resolve));
    const stalledAddress = stalledServer.address();
    if (!stalledAddress || typeof stalledAddress === "string") throw new Error("Expected a TCP test port.");
    try {
      await expect(assertRuntimeStopped(`http://127.0.0.1:${stalledAddress.port}/api/status`))
        .rejects.toThrow("Cannot verify that Tend is stopped");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => stalledServer.close(() => resolve()));
    }
  });
});
