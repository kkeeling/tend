import { Hono } from "hono";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AttentionDomain } from "./server/domain";
import { apiRoutes } from "./server/routes/api";
import { assetRoutes } from "./server/routes/assets";
import { createRealtimeHub } from "./server/routes/realtime";
import { startupResponse } from "./server/routes/startup";
import { createFeedEventBridge } from "./server/realtime/feedEventBridge";
import { PriorityRefreshWorker } from "./server/priorityRefresh";
import { openOrBootstrapLocalRuntime, resolveArtifactsDir, resolveDataDir, resolveDbPath, resolveRuntimeRoot } from "./server/runtime";
import { DrainDispatcher } from "./server/dispatcher";
import { loadMobileCloudEnvFile, mobileCloudConfigFromEnv, SupabaseMobileCloudClient } from "./server/mobile/client";
import { MobileSyncWorker } from "./server/mobile/sync";
import { acquireRuntimeReplacementLock, configurePrivateProcessPermissions, isRecord, makeToken } from "./server/util";

declare const Bun: {
  serve(options: { port: number; hostname: string; idleTimeout: number; fetch: (...args: any[]) => any }): { stop(force?: boolean): void };
};

configurePrivateProcessPermissions();
const root = path.dirname(fileURLToPath(import.meta.url));
loadMobileCloudEnvFile();
const port = Number(process.env.ATTENTION_API_PORT ?? 4332);
const clientDir = process.env.ATTENTION_CLIENT_DIR ?? path.join(root, "dist");
const runtimeRoot = resolveRuntimeRoot(root);
const artifactsDir = resolveArtifactsDir(root);
const dataDir = resolveDataDir(root);
const mutationToken = process.env.ATTENTION_MUTATION_TOKEN ?? makeToken();
const realtime = createRealtimeHub();
let releaseRuntimeReplacementLock: (() => Promise<void>) | null = null;
let fetchHandler: (...args: any[]) => any = (request: Request) => startupResponse(request);
let server: ReturnType<typeof Bun.serve> | null = null;
let sqlite: Awaited<ReturnType<typeof openOrBootstrapLocalRuntime>>["sqlite"] | null = null;
let priorityRefresh: PriorityRefreshWorker | null = null;
let feedEventBridge: ReturnType<typeof createFeedEventBridge> | null = null;
let drainDispatcher: DrainDispatcher | null = null;
let mobileSync: MobileSyncWorker | null = null;
let closePromise: Promise<void> | null = null;

async function releaseReplacementLock(): Promise<void> {
  const release = releaseRuntimeReplacementLock;
  releaseRuntimeReplacementLock = null;
  await release?.();
}

export function closeServer(): Promise<void> {
  if (closePromise) return closePromise;
  closePromise = (async () => {
    const failures: unknown[] = [];
    try {
      server?.stop(true);
    } catch (error) {
      failures.push(error);
    }
    const results = await Promise.allSettled([
      mobileSync?.stop(),
      drainDispatcher?.stop(),
      feedEventBridge?.stop(),
      priorityRefresh?.stop(),
    ]);
    failures.push(...results.flatMap((result) => result.status === "rejected" ? [result.reason] : []));
    if (results.every((result) => result.status === "fulfilled")) {
      try {
        sqlite?.close();
      } catch (error) {
        failures.push(error);
      }
    } else {
      failures.push(new Error("SQLite was deliberately left open because a background worker did not confirm shutdown."));
    }
    try {
      await releaseReplacementLock();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, "Tend shutdown did not cleanly release every resource.");
  })();
  return closePromise;
}

process.once("SIGINT", closeForSignal);
process.once("SIGTERM", closeForSignal);

try {
  server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: 255,
    fetch: (...args: any[]) => fetchHandler(...args),
  });
} catch {
  throw new Error(`Tend cannot start because 127.0.0.1:${port} is already in use.`);
}

try {
  releaseRuntimeReplacementLock = await acquireRuntimeReplacementLock(runtimeRoot);
  const runtime = await openOrBootstrapLocalRuntime(dataDir, resolveDbPath(root));
  sqlite = runtime.sqlite;
  const { store } = runtime;
  const domain = new AttentionDomain(store);
  await domain.refreshWorkspacePriorities();

  const notifyRealtime = (data: unknown) => {
    realtime.notify(data);
    if (isRecord(data) && data.priorityScheduleChanged === true) {
      void priorityRefresh?.requestSchedule();
    }
  };
  const notifyCommittedMutation = async (data: unknown) => {
    try {
      if (!feedEventBridge) {
        realtime.notify(data);
        void priorityRefresh?.requestSchedule();
        return;
      }
      // The durable cursor bridge is the authority for HTTP, scheduled, and
      // out-of-process mutations. Synchronizing it here prevents its interval
      // from echoing a second doorbell for the same committed generation.
      await feedEventBridge.requestPoll();
    } catch (error) {
      // A committed mutation must not look failed just because its wake-up snapshot
      // failed. Wake the browser directly and let the interval reconcile the cursor.
      console.error("[realtime] immediate durable cursor sync failed:", error);
      realtime.notify({ ...(isRecord(data) ? data : {}), source: "mutation-fallback" });
      void priorityRefresh?.requestSchedule();
    }
  };
  priorityRefresh = new PriorityRefreshWorker(domain, notifyCommittedMutation, {
    onError: (error) => console.error("[priority-refresh] scheduling failed; retrying:", error),
  });
  feedEventBridge = createFeedEventBridge(store, notifyRealtime, {
    onError: (error) => console.error("[realtime] durable cursor poll failed:", error),
  });
  drainDispatcher = new DrainDispatcher(store, { appRoot: root, runtimeRoot });
  const mobileConfig = mobileCloudConfigFromEnv();
  mobileSync = mobileConfig
    ? new MobileSyncWorker(store, domain, new SupabaseMobileCloudClient(mobileConfig))
    : null;
  const app = new Hono();

  app.route("/", apiRoutes({
    artifactsDir,
    dataDir,
    domain,
    mobileStatus: () => mobileSync?.currentStatus() ?? { enabled: false },
    mutationToken,
    notify: notifyCommittedMutation,
    port,
    root,
    sqlite,
    store,
  }));
  app.route("/", realtime.routes());
  app.route("/", assetRoutes(clientDir));

  await feedEventBridge.start();
  await priorityRefresh.start();
  if (process.env.ATTENTION_AUTODRAIN === "1") drainDispatcher.start();
  mobileSync?.start();
  fetchHandler = app.fetch;
  await releaseReplacementLock();
} catch (error) {
  await releaseReplacementLock();
  try {
    await closeServer();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], "Tend startup and cleanup both failed.");
  }
  throw error;
}

console.log(`Tend API listening on http://127.0.0.1:${port}`);

function closeForSignal(): void {
  void closeServer().then(
    () => process.exit(0),
    (error) => {
      console.error("[shutdown] cleanup failed:", error);
      process.exit(1);
    },
  );
}
