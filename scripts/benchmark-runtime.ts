import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as requestHttp } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { createLocalRuntime } from "../server/runtime";
import { createRefreshCoalescer } from "../src/state/realtime";
import { mapWithConcurrency } from "../server/util";

const runCount = numericFlag("--runs", 8_000);
const iterations = numericFlag("--iterations", 20);
const cardCount = numericFlag("--cards", 200);
const eventCount = numericFlag("--events", 8_500);
const ledgerCount = numericFlag("--ledger", 250);
const PROCESS_TERM_GRACE_MS = 500;
const PROCESS_KILL_GRACE_MS = 500;
const HTTP_DEADLINE_MS = 5_000;
const STREAM_DRAIN_DEADLINE_MS = 500;
const root = await mkdtemp(path.join(os.tmpdir(), "tend-runtime-benchmark-"));
const dataDir = path.join(root, "data");
const dbPath = path.join(root, "attention.db");
let report: Record<string, unknown> | null = null;
const binaryPath = path.join(process.cwd(), "dist-bin", "tend");
if (!existsSync(binaryPath)) throw new Error("Build the packaged Tend executable with `pnpm tend:build` before running the runtime benchmark.");
const liveProfile = JSON.parse(await readFile(path.join(process.cwd(), "benchmarks", "runtime-profile.json"), "utf8")) as RuntimeProfile;

try {
  const bootstrapStartedAt = performance.now();
  const runtime = await createLocalRuntime(dataDir, dbPath);
  const bootstrapElapsedMs = performance.now() - bootstrapStartedAt;
  const bootstrapStorage = await profileStorage(root, dbPath);
  const domain = new AttentionDomain(runtime.store);
  const feeds = ["inbox", "company-attention"];
  for (const name of ["Primary Work", "Operations", "Personal"]) {
    const feed = await domain.createFeedFromBrief(`${name}\nSynthetic benchmark feed.`, null);
    feeds.push(feed.id);
  }
  await domain.bindFeed("company-attention", "benchmark-thread");
  const sourceIds = new Map<string, string[]>();
  for (const feedId of feeds) {
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const source = await domain.addSourceFromBrief(feedId, `Read synthetic benchmark source ${index + 1}.`);
      ids.push(source.id);
    }
    sourceIds.set(feedId, ids);
  }
  for (let index = 0; index < runCount; index += 1) {
    const feedId = feeds[index % feeds.length] as string;
    const feedSources = sourceIds.get(feedId) as string[];
    const sourceId = feedSources[index % feedSources.length] as string;
    const at = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    await runtime.store.writeRun({
      id: `benchmark-run-${index}`,
      feedId,
      sourceId,
      snapshots: 0,
      judgments: [{ synthetic: "x".repeat(index % 1_000 === 0 ? 20_000 : 4_096) }],
      completedAt: at,
    });
    await runtime.store.appendSourceAttempt({
      id: `benchmark-attempt-${index}`,
      feedId,
      sourceId,
      outcome: "no_change",
      startedAt: at,
      completedAt: at,
      completeness: {
        identityVerified: true,
        scopeVerified: true,
        permissionsComplete: true,
        paginationComplete: true,
        backfillComplete: true,
      },
      runId: `benchmark-run-${index}`,
      checkpointAdvanced: false,
    });
    if (index % 2 === 0) {
      await runtime.store.writeSweepBatch({
        id: `benchmark-batch-${index}`,
        feedId,
        sourceRunIds: [`benchmark-run-${index}`],
        createdAt: at,
      });
    }
  }
  for (let index = 0; index < cardCount; index += 1) {
    const feedId = feeds[index % feeds.length] as string;
    await domain.upsertCard(feedId, {
      id: `benchmark-card-${index}`,
      title: `Synthetic attention card ${index}`,
      why: "Generated performance evidence.",
      blocks: [{ id: "memo", type: "memo", text: "x".repeat(index % 10 === 0 ? 16_000 : 8_192) }],
    });
  }
  for (let index = 0; index < Math.min(cardCount, 160); index += 1) {
    const feedId = feeds[index % feeds.length] as string;
    await domain.queueInstruction(feedId, `benchmark-card-${index}`, "Synthetic queued benchmark instruction.");
  }
  for (let index = cardCount; index < eventCount; index += 1) {
    await runtime.store.appendEvent({
      feedId: feeds[index % feeds.length] as string,
      type: "benchmark.synthetic",
      detail: {
        index,
        synthetic: "x".repeat(index % 1_000 === 0 ? 65_000 : index % 10 === 0 ? 6_000 : 256),
      },
    });
  }
  for (let index = 0; index < ledgerCount; index += 1) {
    await runtime.store.appendPriorityLedger({
      id: `benchmark-ledger-${index}`,
      type: "evaluation",
      at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      inputDigest: `benchmark-${index}`,
      detail: { rank: index + 1, synthetic: true },
    });
  }
  const representativeRaw = path.join(dataDir, "feeds", "inbox", "raw", "benchmark", "source", "payload.json");
  await mkdir(path.dirname(representativeRaw), { recursive: true });
  await writeFile(representativeRaw, `${JSON.stringify({ synthetic: true })}\n`);
  runtime.sqlite.close();

  const storage = await profileStorage(root, dbPath);
  const fixture = { ...profileFixture(dbPath), ...storage };
  for (const [dimension, minimum] of Object.entries(liveProfile.minimum)) {
    assertMinimum(dimension, fixture[dimension as keyof typeof fixture], minimum);
  }
  const sqliteProfile = profileSqlite(dbPath);
  if (
    sqliteProfile.journalMode !== liveProfile.sqlite.journalMode
    || sqliteProfile.pageSize !== liveProfile.sqlite.pageSize
    || sqliteProfile.walState !== liveProfile.sqlite.walState
  ) {
    throw new Error(`SQLite fixture shape diverged: ${JSON.stringify(sqliteProfile)}.`);
  }
  const automationCommandMix = await profileInstalledAutomationCommandMix();
  if (automationCommandMix.discovered) {
    for (const [dimension, minimum] of Object.entries(liveProfile.automationCommandMixMinimum)) {
      assertMinimum(`automation.${dimension}`, automationCommandMix[dimension as keyof typeof automationCommandMix] as number, minimum);
    }
  }

  const commandMix = [
    [binaryPath, "cli", "workspace:now"],
    [binaryPath, "cli", "workspace:coverage"],
    [binaryPath, "cli", "workspace:priority"],
    [binaryPath, "cli", "inspect", "--feed", "inbox"],
    [binaryPath, "cli", "work:list", "--feed", "company-attention", "--thread", "benchmark-thread"],
  ];
  assertMinimum("concurrent benchmark command mix", commandMix.length, liveProfile.automationCommandMixMinimum.automations);
  const env = { ...process.env, ATTENTION_HOME: root };
  const sequential: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    sequential.push(await measure(commandMix[index % commandMix.length] as string[], env));
  }
  const concurrent = await Promise.all(commandMix.map((command) => measure(command, env)));
  const warmSequentialMs = summarize(sequential);
  const fiveWayConcurrentMs = summarize(concurrent);
  assertAtMost("warm sequential p95", warmSequentialMs.p95, 1_000);
  assertAtMost("five-way concurrent p95", fiveWayConcurrentMs.p95, 2_000);
  assertAtMost("five-way concurrent max", fiveWayConcurrentMs.max, 3_000);

  const http = await measureWorkspaceHttp(root, commandMix, env, iterations);
  assertAtMost("authenticated workspace GET p95", http.idle.p95, 750);
  assertAtMost("workspace GET under five CLI reads p95", http.withFiveCli.p95, 2_000);

  const blackHolePreflight = await measureBlackHolePreflight();
  assertAtMost("black-hole preflight process lifetime", blackHolePreflight, 1_000);
  const occupiedPort = await measureOccupiedPortFailure();
  assertAtMost("occupied-port process lifetime", occupiedPort, 1_000);
  const realtimeBurst = http.realtimeBurst;
  assertAtMost("Tend mutation-to-SSE propagation", realtimeBurst.ssePropagationMs, 5_000);
  assertAtMost("realtime trailing refresh start", realtimeBurst.trailingStartMs, 250);
  if (realtimeBurst.refreshes !== 2 || realtimeBurst.maxActiveRequests !== 1 || realtimeBurst.abortedRequests !== 1) {
    throw new Error(`Realtime transport did not coalesce and abort exactly: ${JSON.stringify(realtimeBurst)}.`);
  }

  report = {
    fixture,
    bootstrap: {
      elapsedMs: Math.round(bootstrapElapsedMs * 10) / 10,
      counters: {
        runtimeFilesCreated: bootstrapStorage.runtimeFiles,
        runtimeBytesCreated: bootstrapStorage.runtimeBytes,
        mirrorFilesCreated: bootstrapStorage.mirrorFiles,
        databasePagesCreated: profileSqlite(dbPath).pageCount,
      },
    },
    sqlite: sqliteProfile,
    installedAutomationCommandMix: automationCommandMix,
    warmSequentialMs,
    fiveWayConcurrentMs,
    workspaceHttpMs: { idle: http.idle, withFiveCli: http.withFiveCli },
    blackHolePreflightMs: blackHolePreflight,
    occupiedPortFailureMs: occupiedPort,
    realtimeBurst,
    assertions: {
      fixtureCardinalities: "pass",
      processExitStatus: "pass",
      latencyBudgets: "pass",
    },
  };
} finally {
  await rm(root, { recursive: true, force: true });
}
if (existsSync(root)) throw new Error(`Benchmark fixture cleanup failed: ${root}`);
if (!report) throw new Error("Benchmark did not produce a report.");
report.assertions = { ...(report.assertions as Record<string, unknown>), resourceCleanup: "pass" };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function measure(command: string[], env: Record<string, string | undefined>): Promise<number> {
  const startedAt = performance.now();
  const child = Bun.spawn(command, { cwd: process.cwd(), env, stdout: "ignore", stderr: "pipe" });
  const stderrPromise = readStreamWithin(child.stderr, 10_500, "benchmark CLI stderr");
  const exitCode = await exitWithin(child, 10_000, "benchmark CLI");
  const stderr = await stderrPromise;
  if (exitCode !== 0) throw new Error(stderr || `Benchmark CLI exited ${exitCode}.`);
  return performance.now() - startedAt;
}

async function measureWorkspaceHttp(
  home: string,
  commandMix: string[][],
  cliEnv: Record<string, string | undefined>,
  sampleCount: number,
) {
  const port = await unusedPort();
  const service = Bun.spawn({
    cmd: [binaryPath, "start", "--foreground"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      ATTENTION_API_PORT: String(port),
      ATTENTION_AUTODRAIN: "0",
      ATTENTION_HOME: home,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  let measurements: {
    idle: ReturnType<typeof summarize>;
    withFiveCli: ReturnType<typeof summarize>;
    realtimeBurst: Awaited<ReturnType<typeof measureRealtimeTransport>>;
  } | null = null;
  let serviceExitCode = -1;
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitUntilHealthy(baseUrl, service);
    const session = await fetchExchangeWithin(`${baseUrl}/api/session`, {}, 2_000, "benchmark session");
    if (!session.response.ok) throw new Error(`Benchmark session returned HTTP ${session.response.status}.`);
    const { mutationToken } = JSON.parse(new TextDecoder().decode(session.body)) as { mutationToken: string };
    const headers = { "x-attention-read-token": mutationToken };
    const idle: number[] = [];
    for (let index = 0; index < sampleCount; index += 1) {
      idle.push(await measureHttp(`${baseUrl}/api/workspace`, headers));
    }
    const readers = await startContinuousReaders(commandMix, cliEnv);
    const withFiveCli: number[] = [];
    try {
      for (let index = 0; index < Math.min(sampleCount, 5); index += 1) {
        withFiveCli.push(await measureHttp(`${baseUrl}/api/workspace`, headers));
      }
    } finally {
      await readers.stop();
    }
    const realtimeBurst = await measureRealtimeTransport(baseUrl, mutationToken);
    measurements = { idle: summarize(idle), withFiveCli: summarize(withFiveCli), realtimeBurst };
  } finally {
    serviceExitCode = await terminateWithin(service, 3_000, "benchmark service shutdown") ?? -1;
  }
  if (serviceExitCode !== 0) {
    const stderr = await readStreamWithin(service.stderr, STREAM_DRAIN_DEADLINE_MS, "benchmark service stderr");
    throw new Error(stderr || `Benchmark service exited ${serviceExitCode}.`);
  }
  if (!measurements) throw new Error("Benchmark service produced no workspace measurements.");
  return measurements;
}

async function startContinuousReaders(commandMix: string[][], env: Record<string, string | undefined>) {
  const control = await mkdtemp(path.join(os.tmpdir(), "tend-benchmark-readers-"));
  const children = commandMix.map((command, index) => {
    const ready = path.join(control, `ready-${index}`);
    const stop = path.join(control, `stop-${index}`);
    return {
      ready,
      stop,
      child: Bun.spawn({
        cmd: [process.execPath, path.join(process.cwd(), "scripts", "benchmark-cli-reader.ts"), command[0] as string, ready, stop, ...command.slice(1)],
        cwd: process.cwd(),
        env,
        stdout: "ignore",
        stderr: "pipe",
      }),
    };
  });
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (children.every(({ ready }) => existsSync(ready))) {
        return {
          async stop() {
            await Promise.all(children.map(({ stop }) => writeFile(stop, "stop\n")));
            await Promise.all(children.map(async ({ child }) => {
              const exitCode = await exitWithin(child, 12_000, "continuous benchmark reader");
              if (exitCode !== 0) {
                throw new Error(await readStreamWithin(child.stderr, STREAM_DRAIN_DEADLINE_MS, "continuous reader stderr"));
              }
            }));
            await rm(control, { recursive: true, force: true });
          },
        };
      }
      await Bun.sleep(10);
    }
    throw new Error("Continuous benchmark readers did not reach the SQLite workload barrier.");
  } catch (error) {
    await Promise.all(children.map(({ child }) => terminateWithin(child, 500, "continuous reader startup cleanup")));
    await rm(control, { recursive: true, force: true });
    throw error;
  }
}

async function measureHttp(url: string, headers: Record<string, string>): Promise<number> {
  const startedAt = performance.now();
  const { response } = await fetchExchangeWithin(url, { headers }, HTTP_DEADLINE_MS, `GET ${url}`);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return performance.now() - startedAt;
}

async function waitUntilHealthy(baseUrl: string, service: ReturnType<typeof Bun.spawn>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const exit = await Promise.race([service.exited.then((code) => ({ code })), Bun.sleep(0).then(() => null)]);
    if (exit) throw new Error(`Benchmark service exited during startup (${exit.code}).`);
    try {
      const { response } = await fetchExchangeWithin(`${baseUrl}/api/status`, {}, 250, "benchmark health probe");
      if (response.ok) return;
    } catch {
      // The actual listener is owned before initialization and may not yet accept this probe.
    }
    await Bun.sleep(25);
  }
  throw new Error("Benchmark service did not become healthy within 5 seconds.");
}

async function measureBlackHolePreflight(): Promise<number> {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await listenServerWithin(server, 500, "black-hole benchmark server");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP benchmark port.");
  const env: Record<string, string | undefined> = { ...process.env, ATTENTION_API_PORT: String(address.port) };
  delete env.ATTENTION_HOME;
  const startedAt = performance.now();
  const child = Bun.spawn({
    cmd: [process.execPath, path.join(process.cwd(), "tend.ts"), "cli", "workspace:now"],
    cwd: process.cwd(),
    env,
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const exitCode = await exitWithin(child, 1_000, "black-hole preflight");
    if (exitCode === 0) throw new Error("Black-hole CLI probe unexpectedly succeeded.");
    for (let attempt = 0; attempt < 50 && sockets.size > 0; attempt += 1) await Bun.sleep(5);
    if (sockets.size > 0) throw new Error("Black-hole CLI probe retained a socket after exit.");
    return performance.now() - startedAt;
  } finally {
    await terminateWithin(child, 100, "black-hole cleanup");
    for (const socket of sockets) socket.destroy();
    await closeServerWithin(server, 500, "black-hole benchmark server");
  }
}

async function measureOccupiedPortFailure(): Promise<number> {
  const blocker = createServer();
  await listenServerWithin(blocker, 500, "occupied-port blocker");
  const address = blocker.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP benchmark port.");
  const home = await mkdtemp(path.join(os.tmpdir(), "tend-occupied-benchmark-"));
  const startedAt = performance.now();
  const child = Bun.spawn({
    cmd: [process.execPath, path.join(process.cwd(), "tend.ts"), "start", "--foreground"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      ATTENTION_API_PORT: String(address.port),
      ATTENTION_AUTODRAIN: "0",
      ATTENTION_HOME: home,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const exitCode = await exitWithin(child, 1_000, "occupied-port start");
    if (exitCode === 0) throw new Error("Occupied-port service start unexpectedly succeeded.");
    if (existsSync(path.join(home, "attention.db")) || existsSync(path.join(home, "data"))) {
      throw new Error("Occupied-port service start mutated its runtime.");
    }
    return performance.now() - startedAt;
  } finally {
    await terminateWithin(child, 100, "occupied-port cleanup");
    await closeServerWithin(blocker, 500, "occupied-port blocker");
    await rm(home, { recursive: true, force: true });
  }
}

async function exitWithin(
  child: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
  label: string,
): Promise<number> {
  const result = await processExitWithin(child, timeoutMs);
  if (typeof result === "number") return result;
  const termination = await terminateWithin(child, PROCESS_TERM_GRACE_MS, label);
  throw new Error(
    `${label} exceeded its hard ${timeoutMs}ms process deadline`
    + `${termination === null ? " and remained alive after TERM/KILL grace periods" : ""}.`,
  );
}

async function terminateWithin(
  child: ReturnType<typeof Bun.spawn>,
  graceMs: number,
  label: string,
): Promise<number | null> {
  const alreadyExited = await processExitWithin(child, 0);
  if (typeof alreadyExited === "number") return alreadyExited;
  try {
    child.kill("SIGTERM");
  } catch {
    // The process may have exited between the probe and the signal.
  }
  const afterTerm = await processExitWithin(child, graceMs);
  if (typeof afterTerm === "number") return afterTerm;
  try {
    child.kill("SIGKILL");
  } catch {
    // The process may have exited between grace periods.
  }
  const afterKill = await processExitWithin(child, PROCESS_KILL_GRACE_MS);
  if (typeof afterKill === "number") return afterKill;
  process.stderr.write(`[benchmark] ${label} remained alive after SIGTERM and SIGKILL grace periods.\n`);
  return null;
}

async function processExitWithin(
  child: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<number | symbol> {
  const timeout = Symbol("timeout");
  return Promise.race([
    child.exited,
    Bun.sleep(Math.max(0, timeoutMs)).then(() => timeout),
  ]);
}

async function readStreamWithin(
  stream: ReadableStream<Uint8Array> | null,
  timeoutMs: number,
  label: string,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  const read = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  })();
  try {
    await bodyWithin(read, timeoutMs, label, () => {
      void reader.cancel().catch(() => {});
    });
    return new TextDecoder().decode(Buffer.concat(chunks));
  } catch (error) {
    if (error instanceof Error && error.message.includes("deadline")) return "";
    throw error;
  }
}

async function fetchWithin(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  return withAbortDeadline(init.signal, timeoutMs, label, (signal) => fetch(input, { ...init, signal }));
}

async function fetchExchangeWithin(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<{ response: Response; body: ArrayBuffer }> {
  return withAbortDeadline(init.signal, timeoutMs, label, async (signal) => {
    const response = await fetch(input, { ...init, signal });
    const body = await response.arrayBuffer();
    return { response, body };
  });
}

async function withAbortDeadline<T>(
  upstream: AbortSignal | null | undefined,
  timeoutMs: number,
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let expired = false;
  const abort = () => controller.abort(upstream?.reason);
  if (upstream?.aborted) abort();
  else upstream?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new Error(`${label} deadline exceeded`));
  }, timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (expired) throw new Error(`${label} exceeded its hard ${timeoutMs}ms network deadline.`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    upstream?.removeEventListener("abort", abort);
  }
}

async function bodyWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`${label} exceeded its hard ${timeoutMs}ms deadline.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeServerWithin(
  server: { close(callback: (error?: Error) => void): unknown; closeAllConnections?: () => void },
  timeoutMs: number,
  label: string,
): Promise<void> {
  const close = new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => error ? reject(error) : resolve());
  });
  try {
    await bodyWithin(close, timeoutMs, label, () => server.closeAllConnections?.());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") return;
    server.closeAllConnections?.();
    await bodyWithin(close, timeoutMs, `${label} forced close`);
    if (error instanceof Error && !error.message.includes("deadline")) throw error;
  }
}

async function listenServerWithin(
  server: {
    listen(port: number, host: string): unknown;
    once(event: "listening", listener: () => void): unknown;
    once(event: "error", listener: (error: Error) => void): unknown;
    removeListener(event: "listening", listener: () => void): unknown;
    removeListener(event: "error", listener: (error: Error) => void): unknown;
    close(callback?: (error?: Error) => void): unknown;
  },
  timeoutMs: number,
  label: string,
): Promise<void> {
  let onListening!: () => void;
  let onError!: (error: Error) => void;
  const listening = new Promise<void>((resolve, reject) => {
    onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(0, "127.0.0.1");
  });
  try {
    await bodyWithin(listening, timeoutMs, label, () => {
      try {
        server.close();
      } catch {
        // The listener may not have been acquired.
      }
    });
  } finally {
    server.removeListener("listening", onListening);
    server.removeListener("error", onError);
  }
}

async function measureRealtimeTransport(
  baseUrl: string,
  mutationToken: string,
): Promise<{ refreshes: number; ssePropagationMs: number; trailingStartMs: number; maxActiveRequests: number; abortedRequests: number }> {
  let refreshes = 0;
  let trailingStartedAt = 0;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let abortedRequests = 0;
  let requestsSeen = 0;
  const blocked = createHttpServer((request, response) => {
    requestsSeen += 1;
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    let settled = false;
    const settle = (aborted: boolean) => {
      if (settled) return;
      settled = true;
      activeRequests -= 1;
      if (aborted) abortedRequests += 1;
    };
    request.once("aborted", () => settle(true));
    response.once("close", () => settle(!response.writableEnded));
    response.writeHead(200, { "connection": "close", "content-type": "application/json" });
    response.flushHeaders();
    if (requestsSeen > 1) {
      response.end("{}");
      settle(false);
    }
  });
  await listenServerWithin(blocked, 500, "realtime blocked server");
  const address = blocked.address();
  if (!address || typeof address === "string") throw new Error("Expected a realtime benchmark port.");
  const activeController: { current: AbortController | null } = { current: null };
  let activeRequest: Promise<void> | null = null;
  let burstStartedAt = 0;
  let mutationStartedAt = 0;
  let ssePropagationMs = 0;
  const scheduler = createRefreshCoalescer(
    async () => {
      refreshes += 1;
      if (refreshes > 1) trailingStartedAt = performance.now();
      const controller = new AbortController();
      activeController.current = controller;
      const request = requestBodyWithin(
        `http://127.0.0.1:${address.port}/blocked-workspace`,
        controller.signal,
        6_000,
        "blocked workspace refresh",
      )
        .catch((error) => {
          if (controller.signal.aborted && error instanceof Error && error.name === "AbortError") return;
          throw error;
        });
      activeRequest = request;
      try {
        await request;
      } finally {
        if (activeRequest === request) activeRequest = null;
      }
    },
    {
      cancelActive: () => {
        activeController.current?.abort();
        return activeRequest?.catch(() => {});
      },
    },
  );
  const events = new BenchmarkSseClient(`${baseUrl}/api/events`);
  try {
    await eventWithin(events, "ready", 2_000);
    let recordChange!: () => void;
    const changeSeen = new Promise<void>((resolve) => { recordChange = resolve; });
    const burst = new Promise<void>((resolve, reject) => {
      events.addEventListener("change", () => {
        recordChange();
        burstStartedAt = performance.now();
        ssePropagationMs = burstStartedAt - mutationStartedAt;
        const completion = scheduler.request();
        void (async () => {
          for (let attempt = 0; attempt < 250 && requestsSeen === 0; attempt += 1) {
            await Bun.sleep(1);
          }
          if (requestsSeen === 0) throw new Error("The initial browser refresh did not reach its transport.");
          for (let index = 0; index < 20; index += 1) scheduler.request();
          await completion;
        })().then(resolve, reject);
      }, { once: true });
    });
    mutationStartedAt = performance.now();
    const mutation = await fetchExchangeWithin(`${baseUrl}/api/workspace/instructions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-attention-mutation-token": mutationToken,
      },
      body: JSON.stringify({
        cardRef: { feedId: "inbox", cardId: "benchmark-card-0" },
        instruction: "Synthetic realtime transport benchmark.",
      }),
    }, 3_000, "realtime benchmark mutation");
    if (!mutation.response.ok) {
      throw new Error(
        `Realtime benchmark mutation returned HTTP ${mutation.response.status}: `
        + new TextDecoder().decode(mutation.body),
      );
    }
    await Promise.race([
      changeSeen,
      Bun.sleep(5_000).then(() => {
        throw new Error("Actual Tend mutation did not produce an SSE change frame.");
      }),
    ]);
    await Promise.race([
      burst,
      Bun.sleep(6_000).then(() => {
        throw new Error(
          "Actual Tend SSE change reached the browser, but its refresh burst did not settle: "
          + JSON.stringify({
            refreshes,
            requestsSeen,
            activeRequests,
            maxActiveRequests,
            abortedRequests,
            activeAborted: activeController.current?.signal.aborted ?? false,
          }),
        );
      }),
    ]);
    return { refreshes, ssePropagationMs, trailingStartMs: trailingStartedAt - burstStartedAt, maxActiveRequests, abortedRequests };
  } finally {
    scheduler.dispose();
    await events.close();
    activeController.current?.abort();
    await closeServerWithin(blocked, 500, "realtime blocked server");
  }
}

async function requestBodyWithin(
  input: string,
  upstream: AbortSignal,
  timeoutMs: number,
  label: string,
): Promise<void> {
  return withAbortDeadline(upstream, timeoutMs, label, (signal) => new Promise<void>((resolve, reject) => {
    let settled = false;
    let response: import("node:http").IncomingMessage | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      const error = new Error("The workspace refresh was aborted.");
      error.name = "AbortError";
      finish(error);
      response?.destroy(error);
      request.destroy(error);
    };
    const request = requestHttp(input, (incoming) => {
      response = incoming;
      incoming.on("data", () => {});
      incoming.once("end", () => finish());
      incoming.once("error", (error) => finish(error));
    });
    request.once("error", (error) => finish(error));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else request.end();
  }));
}

function eventWithin(events: BenchmarkSseClient, type: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      clearTimeout(timeout);
      events.removeEventListener(type, onEvent);
      resolve();
    };
    const timeout = setTimeout(() => {
      events.removeEventListener(type, onEvent);
      reject(new Error(`Timed out waiting for SSE ${type}.`));
    }, timeoutMs);
    events.addEventListener(type, onEvent);
  });
}

class BenchmarkSseClient {
  private readonly controller = new AbortController();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly reading: Promise<void>;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  constructor(url: string) {
    this.reading = this.read(url);
  }

  addEventListener(type: string, listener: () => void, options: { once?: boolean } = {}): void {
    const wrapped = options.once
      ? () => {
          this.listeners.get(type)?.delete(wrapped);
          listener();
        }
      : listener;
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(wrapped);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  async close(): Promise<void> {
    this.controller.abort();
    void this.reader?.cancel().catch(() => {});
    await bodyWithin(this.reading.catch(() => {}), STREAM_DRAIN_DEADLINE_MS, "benchmark SSE reader shutdown");
  }

  private async read(url: string): Promise<void> {
    const response = await fetchWithin(url, { signal: this.controller.signal }, 2_000, "benchmark SSE connect");
    if (!response.ok || !response.body) throw new Error(`SSE endpoint returned HTTP ${response.status}.`);
    const reader = response.body.getReader();
    this.reader = reader;
    if (this.controller.signal.aborted) void reader.cancel().catch(() => {});
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          const eventType = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
          if (eventType) for (const listener of this.listeners.get(eventType) ?? []) listener();
        }
      }
    } catch (error) {
      if (!this.controller.signal.aborted) throw error;
    } finally {
      this.reader = null;
      reader.releaseLock();
    }
  }
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await listenServerWithin(server, 500, "unused-port probe");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP benchmark port.");
  await closeServerWithin(server, 500, "unused-port probe");
  return address.port;
}

function profileFixture(dbPath: string) {
  const database = new Database(dbPath, { readonly: true });
  try {
    const count = (table: string) => Number((database.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
    const payload = (table: string, column = "payload_json") => {
      const values = (database.query(`SELECT length(${column}) AS bytes FROM ${table} ORDER BY bytes`).all() as { bytes: number | null }[])
        .map((row) => Number(row.bytes ?? 0));
      return {
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        max: values.at(-1) ?? 0,
      };
    };
    const sourceRunPayload = payload("source_runs");
    const cardPayload = payload("cards");
    const eventPayload = payload("feed_events", "detail_json");
    return {
      feeds: count("workspace_feeds"),
      sources: count("source_recipes"),
      sourceRuns: count("source_runs"),
      sourceAttempts: count("source_attempts"),
      sweepBatches: count("sweep_batches"),
      cards: count("cards"),
      feedEvents: count("feed_events"),
      priorityLedger: count("priority_ledger"),
      workItems: count("work_items"),
      sourceRunPayloadP50Bytes: sourceRunPayload.p50,
      sourceRunPayloadP95Bytes: sourceRunPayload.p95,
      sourceRunPayloadMaxBytes: sourceRunPayload.max,
      cardPayloadP50Bytes: cardPayload.p50,
      cardPayloadP95Bytes: cardPayload.p95,
      cardPayloadMaxBytes: cardPayload.max,
      eventPayloadP50Bytes: eventPayload.p50,
      eventPayloadP95Bytes: eventPayload.p95,
      eventPayloadMaxBytes: eventPayload.max,
    };
  } finally {
    database.close();
  }
}

async function profileStorage(runtimeRoot: string, databasePath: string) {
  let runtimeBytes = 0;
  let runtimeFiles = 0;
  let maxDirectoryDepth = 0;
  let sourceRunMirrorFiles = 0;
  let cardMirrorFiles = 0;
  let sweepMirrorFiles = 0;
  let workMirrorFiles = 0;
  const directories = [runtimeRoot];
  const files: Array<{ path: string; name: string }> = [];
  while (directories.length > 0) {
    const batch = directories.splice(0, 16);
    const batches = await mapWithConcurrency(batch, 16, async (directory) => ({
      directory,
      entries: await readdir(directory, { withFileTypes: true }),
    }));
    for (const { directory, entries } of batches) {
      const relativeDirectory = path.relative(runtimeRoot, directory);
      maxDirectoryDepth = Math.max(
        maxDirectoryDepth,
        relativeDirectory ? relativeDirectory.split(path.sep).length : 0,
      );
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) directories.push(entryPath);
        else if (entry.isFile()) files.push({ path: entryPath, name: entry.name });
      }
    }
  }
  const sizes = await mapWithConcurrency(files, 32, async (file) => (await stat(file.path)).size);
  for (const [index, file] of files.entries()) {
    runtimeFiles += 1;
    runtimeBytes += sizes[index] as number;
    const segments = path.relative(runtimeRoot, file.path).split(path.sep);
    const parent = segments.at(-2);
    if (parent === "runs" && file.name.endsWith(".json")) sourceRunMirrorFiles += 1;
    if (parent === "cards" && file.name.endsWith(".json")) cardMirrorFiles += 1;
    if (parent === "sweeps" && file.name.endsWith(".json")) sweepMirrorFiles += 1;
    if (parent === "work" && file.name.endsWith(".json")) workMirrorFiles += 1;
  }
  const mirrorFiles = sourceRunMirrorFiles + cardMirrorFiles + sweepMirrorFiles + workMirrorFiles;
  return {
    databaseBytes: (await stat(databasePath)).size,
    runtimeBytes,
    runtimeFiles,
    maxDirectoryDepth,
    mirrorFiles,
    sourceRunMirrorFiles,
    cardMirrorFiles,
    sweepMirrorFiles,
    workMirrorFiles,
  };
}

function profileSqlite(dbPath: string) {
  const database = new Database(dbPath, { readonly: true });
  try {
    const walPath = `${dbPath}-wal`;
    const walBytes = existsSync(walPath) ? Number(Bun.file(walPath).size) : 0;
    return {
      journalMode: String((database.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode),
      pageSize: Number((database.query("PRAGMA page_size").get() as { page_size: number }).page_size),
      pageCount: Number((database.query("PRAGMA page_count").get() as { page_count: number }).page_count),
      freelistCount: Number((database.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count),
      walExists: existsSync(walPath),
      walBytes,
      walState: walBytes > 0 ? "active" : "inactive",
    };
  } finally {
    database.close();
  }
}

async function profileInstalledAutomationCommandMix() {
  const result = {
    discovered: false,
    automations: 0,
    health: 0,
    inspect: 0,
    workList: 0,
    workClaim: 0,
    imessageCollect: 0,
  };
  const automationRoot = path.join(os.homedir(), ".codex", "automations");
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(automationRoot, { withFileTypes: true });
  } catch {
    return result;
  }
  const definitions = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("tend-"))
    .map((entry) => path.join(automationRoot, entry.name, "automation.toml"));
  const contents = await mapWithConcurrency(definitions, 8, async (definition) => {
    try {
      return await readFile(definition, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  });
  for (const content of contents) {
    if (content === null) continue;
    result.automations += 1;
    if (/\bhealth\b/.test(content)) result.health += 1;
    if (/\binspect\b/.test(content)) result.inspect += 1;
    if (/\bwork:list\b/.test(content)) result.workList += 1;
    if (/\bwork:claim\b/.test(content)) result.workClaim += 1;
    if (/\bimessage\s+collect\b/.test(content)) result.imessageCollect += 1;
  }
  result.discovered = result.automations > 0;
  return result;
}

function assertMinimum(label: string, actual: number, minimum: number): void {
  if (actual < minimum) throw new Error(`${label} fixture diverged: expected at least ${minimum}, observed ${actual}.`);
}

function assertAtMost(label: string, actual: number, maximum: number): void {
  if (actual > maximum) throw new Error(`${label} exceeded ${maximum}ms: ${actual}ms.`);
}

function summarize(values: number[]): { median: number; p95: number; max: number } {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
  };
}

function percentile(values: number[], quantile: number): number {
  if (!values.length) return 0;
  return Math.round((values[Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)] ?? 0) * 10) / 10;
}

function numericFlag(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

type RuntimeProfile = {
  minimum: {
    feeds: number;
    sources: number;
    sourceRuns: number;
    sourceAttempts: number;
    sweepBatches: number;
    cards: number;
    feedEvents: number;
    priorityLedger: number;
    workItems: number;
    databaseBytes: number;
    runtimeBytes: number;
    runtimeFiles: number;
    maxDirectoryDepth: number;
    mirrorFiles: number;
    sourceRunMirrorFiles: number;
    cardMirrorFiles: number;
    sweepMirrorFiles: number;
    workMirrorFiles: number;
    sourceRunPayloadP50Bytes: number;
    sourceRunPayloadP95Bytes: number;
    sourceRunPayloadMaxBytes: number;
    cardPayloadP50Bytes: number;
    cardPayloadP95Bytes: number;
    cardPayloadMaxBytes: number;
    eventPayloadP50Bytes: number;
    eventPayloadP95Bytes: number;
    eventPayloadMaxBytes: number;
  };
  sqlite: {
    journalMode: string;
    pageSize: number;
    walState: string;
  };
  automationCommandMixMinimum: {
    automations: number;
    health: number;
    inspect: number;
    workList: number;
    workClaim: number;
    imessageCollect: number;
  };
};
