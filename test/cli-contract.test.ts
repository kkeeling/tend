import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { runTendCli } from "../server/cli";
import { CLI_COMMANDS, INTERNAL_CLI_COMMANDS, cliCommandName } from "../server/cli/contract";
import { MissingFlagError, formatCliError } from "../server/cli/errors";
import { assertCliRuntimeMatchesLive, fetchLiveStatus } from "../server/cli/runtimeGuard";
import { setupChroniclePrompt, setupCodexPrompt } from "../server/cli/setup";
import { createLocalRuntime } from "../server/runtime";

describe("CLI contract", () => {
  test("keeps public help focused on the v0 agent surface", () => {
    const commandNames = new Set(CLI_COMMANDS.map(cliCommandName));

    expect(commandNames).toContain("feed:bind");
    expect(commandNames).toContain("context:bind");
    expect(commandNames).toContain("context:publish");
    expect(commandNames).toContain("context:status");
    expect(commandNames).toContain("context:for-feed");
    expect(commandNames).toContain("agent:presence");
    expect(commandNames).toContain("work:list");
    expect(commandNames).toContain("work:claim");
    expect(commandNames).toContain("work:assign");
    expect(commandNames).toContain("feed:drain-agent");
    expect(commandNames).toContain("action:verify");
    expect(commandNames).toContain("work:complete");
    expect(commandNames).toContain("work:reconcile-approved");
    expect(commandNames).toContain("source:record-run");
    expect(commandNames).toContain("commitment:rehome");
    expect(commandNames).toContain("commitment:completion:evidence");
    expect(commandNames).toContain("commitment:signal:change");
    expect(commandNames).toContain("card:upsert");
    expect(commandNames).toContain("card:dismiss");
    expect(commandNames).toContain("card:cleanup-source");
    expect(commandNames).toContain("card:undo-cleanup-source");
    expect(commandNames).not.toContain("card:dismiss-local");
    expect(commandNames).not.toContain("card:undo-dismiss");
    expect(commandNames).toContain("learning:request");

    for (const command of INTERNAL_CLI_COMMANDS) {
      expect(commandNames).not.toContain(cliCommandName(command));
    }
  });

  test("documents only implemented public commands", async () => {
    const contract = await readFile("docs/AGENT_CONTRACT.md", "utf8");
    const documented = [...contract.matchAll(/`tend cli ([^`\s]+)/g)].map((match) => match[1]);
    const commandNames = new Set(CLI_COMMANDS.map(cliCommandName));

    expect(documented.length).toBeGreaterThan(10);
    for (const command of documented) expect(commandNames).toContain(command);
  });

  test("formats command-owned usage hints for missing flags", () => {
    const error = formatCliError(new MissingFlagError("work:claim", "thread"));

    expect(error).toEqual({
      ok: false,
      error: "Missing --thread",
      code: "missing_flag",
      hint: "Usage: tend cli work:claim --feed <id> --thread <id> [--cross-feed] [--session <id>]",
    });
    expect(CLI_COMMANDS.find((command) => command.startsWith("feed:bind "))).toContain("--agent claude [--replace]");
  });

  test("prints a self-contained Codex setup prompt for binary installs", () => {
    const prompt = setupCodexPrompt({
      binaryPath: "/tmp/tend install/tend",
      skillPath: "/tmp/tend install/docs/SKILL.md",
      attentionHome: "/tmp/tend home",
      feedId: "model-watch",
    });

    expect(prompt).toContain("Tend is Codex-native.");
    expect(prompt).toContain('This prompt connects the current thread to "model-watch"');
    expect(prompt).toContain("Local Tend entry point: /tmp/tend install/tend");
    expect(prompt).toContain("Skill/reference: /tmp/tend install/docs/SKILL.md");
    expect(prompt).toContain("CLI prefix: ATTENTION_HOME='/tmp/tend home' '/tmp/tend install/tend'");
    expect(prompt).toContain("Use the local Tend CLI contract, not a hosted Tend or MCP setup.");
    expect(prompt).toContain("Do setup sequentially: bind first and wait for it to finish, then propose/install the heartbeat.");
    expect(prompt).toContain("ATTENTION_HOME='/tmp/tend home' '/tmp/tend install/tend' cli feed:bind --feed model-watch --thread <current-codex-thread-id>");
    expect(prompt).toContain('says "go deal with the feed"');
  });

  test("prints a self-contained Chronicle Pulse setup prompt", () => {
    const prompt = setupChroniclePrompt({
      binaryPath: "/tmp/tend install/tend",
      skillPath: "/tmp/tend install/docs/SKILL.md",
      attentionHome: "/tmp/tend home",
    });

    expect(prompt).toContain("one dedicated Chronicle Pulse thread for the entire Tend workspace");
    expect(prompt).toContain("Tend does not capture the screen itself.");
    expect(prompt).toContain("Agent contract: /tmp/tend install/docs/AGENT_CONTRACT.md");
    expect(prompt).toContain("Security reference: /tmp/tend install/docs/SECURITY.md");
    expect(prompt).toContain("ATTENTION_HOME='/tmp/tend home' '/tmp/tend install/tend' cli context:bind --thread <current-codex-thread-id>");
    expect(prompt).toContain("refreshes the pulse every two hours");
    expect(prompt).toContain("one coherent window of ten minutes or less");
    expect(prompt).toContain("cli context:publish --thread <current-codex-thread-id> --context-file <local-json-file>");
    expect(prompt).toContain('says "refresh the pulse"');
  });

  test("keeps agent commands under the explicit cli namespace", async () => {
    await expect(runTendCli(["work:list", "--feed", "inbox", "--thread", "thread"]))
      .rejects.toThrow('Unknown Tend command "work:list". Run tend help.');
  });

  test("refuses an implicit CLI runtime that differs from the running service", async () => {
    const mismatch = assertCliRuntimeMatchesLive("/tmp/quiet-runtime", {
      fetchStatus: async () => ({ dataDir: "/tmp/live-runtime/data" }),
    });
    await expect(mismatch).rejects.toMatchObject({
      code: "runtime_mismatch",
      hint: "Run the CLI from the canonical checkout or set ATTENTION_HOME explicitly for isolated validation.",
    });

    await expect(assertCliRuntimeMatchesLive("/tmp/quiet-runtime", {
      explicitRuntime: true,
      fetchStatus: async () => ({ dataDir: "/tmp/live-runtime/data" }),
    })).resolves.toBeUndefined();
  });

  test("treats a stalled live status probe as a bounded terminal failure", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test port.");
    const startedAt = performance.now();
    try {
      await expect(fetchLiveStatus(`http://127.0.0.1:${address.port}/api/status`, 50))
        .rejects.toMatchObject({ code: "runtime_status_timeout" });
      // The suite also runs CPU-heavy SQLite and React tests in parallel. Keep
      // the externally meaningful one-second process-exit budget without
      // mistaking scheduler contention for an unbounded status probe.
      expect(performance.now() - startedAt).toBeLessThan(1_000);

      const env = { ...process.env, ATTENTION_API_PORT: String(address.port) };
      delete env.ATTENTION_HOME;
      const subprocess = Bun.spawn({
        cmd: [process.execPath, "tend.ts", "cli", "workspace:now"],
        cwd: process.cwd(),
        env,
        stdout: "ignore",
        stderr: "pipe",
      });
      const subprocessStartedAt = performance.now();
      const timeout = Symbol("timeout");
      const exitCode = await Promise.race([
        subprocess.exited,
        Bun.sleep(1_000).then(() => timeout),
      ]);
      if (exitCode === timeout) {
        subprocess.kill("SIGTERM");
        await subprocess.exited;
      }
      expect(exitCode).not.toBe(timeout);
      expect(exitCode).not.toBe(0);
      expect(performance.now() - subprocessStartedAt).toBeLessThan(1_000);
      // The packaged process lifetime above is the authoritative leak check.
      // Happy DOM replaces event globals for concurrent browser tests and can
      // delay this in-process fixture's server-side `close` observation even
      // after the client has force-reset its socket.
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("executes the renamed local-dismiss and source-cleanup commands end to end", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "tend-cli-disposition-"));
    const run = async (args: string[]) => {
      const subprocess = Bun.spawn({
        cmd: [process.execPath, "tend.ts", "cli", ...args],
        cwd: process.cwd(),
        env: { ...process.env, ATTENTION_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ]);
      if (exitCode !== 0) throw new Error(stderr || `CLI exited ${exitCode}`);
      return JSON.parse(stdout);
    };

    try {
      const runtime = await createLocalRuntime(path.join(home, "data"), path.join(home, "attention.db"));
      runtime.sqlite.close();
      const card = {
        id: "cli-disposition",
        title: "Choose the disposition.",
        why: "The CLI must distinguish local dismissal from source cleanup.",
        blocks: [{ id: "memo", type: "memo", text: "Routine notice." }],
      };
      await run(["card:upsert", "--feed", "inbox", "--card", JSON.stringify(card)]);

      const dismissed = await run(["card:dismiss", "--feed", "inbox", "--card", card.id]);
      expect(dismissed).toMatchObject({ status: "done", completionDisposition: "dismissed" });

      await run(["card:return-to-review", "--feed", "inbox", "--card", card.id]);
      await run([
        "card:upsert",
        "--feed",
        "inbox",
        "--card",
        JSON.stringify({ ...card, actions: [{ id: "archive-source", label: "Archive", behavior: "default_cleanup" }] }),
      ]);
      const cleanup = await run(["card:cleanup-source", "--feed", "inbox", "--card", card.id]);
      expect(cleanup).toMatchObject({ kind: "default_cleanup", status: "queued" });
      expect(cleanup.approvalDigest).toBeTruthy();

      const restored = await run(["card:undo-cleanup-source", "--feed", "inbox", "--card", card.id]);
      expect(restored).toMatchObject({ status: "to_review_updated" });
      expect(restored.completionDisposition).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a mistyped explicit runtime refuses agent commands without creating state", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "tend-cli-mistyped-home-"));
    const home = path.join(parent, "typo");
    const subprocess = Bun.spawn({
      cmd: [process.execPath, "tend.ts", "cli", "workspace:now"],
      cwd: process.cwd(),
      env: { ...process.env, ATTENTION_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const [stderr, exitCode] = await Promise.all([
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("has not completed bootstrap");
      expect(existsSync(home)).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
