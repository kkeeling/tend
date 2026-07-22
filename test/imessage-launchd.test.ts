import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectIMessageViaLaunchd,
  normalizeCollectArguments,
} from "../server/cli/imessage";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; helper: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-imessage-launchd-test-"));
  roots.push(root);
  const helper = path.join(root, "tend-imessage-helper");
  await writeFile(helper, "fixture", { mode: 0o700 });
  return { root, helper };
}

describe("packaged Messages launchd runner", () => {
  test("submits only the exact helper and removes its private lifecycle artifacts", async () => {
    const { root, helper } = await fixture();
    const commands: string[][] = [];
    const result = await collectIMessageViaLaunchd([
      "collect",
      "--since",
      "2026-07-21T00:00:00Z",
      "--limit",
      "25",
    ], {
      platform: "darwin",
      helperPath: helper,
      temporaryRoot: root,
      now: () => Date.parse("2026-07-22T00:00:00Z"),
      run: async (command) => {
        commands.push(command);
        if (command[1] === "submit") {
          const output = command[command.indexOf("-o") + 1]!;
          const error = command[command.indexOf("-e") + 1]!;
          expect((await stat(path.dirname(output))).mode & 0o777).toBe(0o700);
          expect((await stat(output)).mode & 0o777).toBe(0o600);
          expect((await stat(error)).mode & 0o777).toBe(0o600);
          await writeFile(output, `${JSON.stringify({ ok: true, schema: "tend.imessage.readonly.v1", messages: [] })}\n`);
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(result).toMatchObject({ ok: true, schema: "tend.imessage.readonly.v1" });
    expect(commands[0]).toEqual([
      "launchctl",
      "submit",
      "-l",
      expect.stringContaining("com.every.tend.imessage-collect."),
      "-p",
      helper,
      "-o",
      expect.stringContaining("result.json"),
      "-e",
      expect.stringContaining("error.json"),
      "--",
      helper,
      "collect",
      "--since",
      "2026-07-21T00:00:00.000Z",
      "--limit",
      "25",
    ]);
    expect(commands.at(-1)?.slice(0, 2)).toEqual(["launchctl", "remove"]);
    expect(await readdir(root)).toEqual(["tend-imessage-helper"]);
  });

  test("returns a helper denial and still removes the job and temporary files", async () => {
    const { root, helper } = await fixture();
    const commands: string[][] = [];
    const result = await collectIMessageViaLaunchd([
      "collect",
      "--since",
      "2026-07-21T00:00:00Z",
    ], {
      platform: "darwin",
      helperPath: helper,
      temporaryRoot: root,
      now: () => Date.parse("2026-07-22T00:00:00Z"),
      run: async (command) => {
        commands.push(command);
        if (command[1] === "submit") {
          const error = command[command.indexOf("-e") + 1]!;
          await writeFile(error, `${JSON.stringify({ ok: false, outcome: "permission_denied" })}\n`);
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(result).toEqual({ ok: false, outcome: "permission_denied" });
    expect(commands.at(-1)?.slice(0, 2)).toEqual(["launchctl", "remove"]);
    expect(await readdir(root)).toEqual(["tend-imessage-helper"]);
  });

  test("rejects unbounded or malformed arguments before launching", () => {
    expect(() => normalizeCollectArguments(["collect", "--since", "2026-01-01T00:00:00Z"], new Date("2026-07-22T00:00:00Z")))
      .toThrow("cannot exceed 90 days");
    expect(() => normalizeCollectArguments(["collect", "--since", "2026-07-21T00:00:00Z", "--limit", "501"], new Date("2026-07-22T00:00:00Z")))
      .toThrow("between 1 and 500");
    expect(() => normalizeCollectArguments(["collect", "--since", "2026-07-21T00:00:00Z", "--database", "/tmp/chat.db"], new Date("2026-07-22T00:00:00Z")))
      .toThrow("Usage: tend imessage collect");
  });

  test("removes the job and temporary files when the helper times out", async () => {
    const { root, helper } = await fixture();
    const commands: string[][] = [];
    let now = Date.parse("2026-07-22T00:00:00Z");
    await expect(collectIMessageViaLaunchd([
      "collect",
      "--since",
      "2026-07-21T00:00:00Z",
    ], {
      platform: "darwin",
      helperPath: helper,
      temporaryRoot: root,
      timeoutMs: 50,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      run: async (command) => {
        commands.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    })).rejects.toThrow("before the timeout");

    expect(commands.at(-1)?.slice(0, 2)).toEqual(["launchctl", "remove"]);
    expect(await readdir(root)).toEqual(["tend-imessage-helper"]);
  });
});
