import type { MobileCommandProgress, MobileCommandResult, MobileSyncStatus } from "../../shared/mobile";
import type { AttentionDomain } from "../domain";
import type { AttentionStore } from "../store";
import type { MobileCloudClient } from "./client";
import { projectMobileWorkspace, sanitizeText } from "./projection";

export interface MobileSyncWorkerOptions {
  intervalMs?: number;
  fullReconcileMs?: number;
  shutdownTimeoutMs?: number;
  now?: () => Date;
  onStatus?: (status: MobileSyncStatus) => void;
}

export class MobileSyncWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentRun: Promise<MobileSyncStatus> | null = null;
  private currentController: AbortController | null = null;
  private stopping = false;
  private lastFullReconcileAt = 0;
  private status: MobileSyncStatus = { enabled: true };
  private readonly options: Required<Pick<MobileSyncWorkerOptions, "intervalMs" | "fullReconcileMs" | "shutdownTimeoutMs" | "now">> & MobileSyncWorkerOptions;

  constructor(
    private readonly store: AttentionStore,
    private readonly domain: AttentionDomain,
    private readonly client: MobileCloudClient,
    options: MobileSyncWorkerOptions = {},
  ) {
    this.options = {
      intervalMs: 2_500,
      fullReconcileMs: 60_000,
      shutdownTimeoutMs: 5_000,
      now: () => new Date(),
      ...options,
    };
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => void this.runOnce(), this.options.intervalMs);
    void this.runOnce();
    console.log(`[mobile-sync] watching every ${Math.round(this.options.intervalMs / 100) / 10}s`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.currentController?.abort();
    if (!this.currentRun) return;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        this.currentRun,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Mobile sync shutdown exceeded ${this.options.shutdownTimeoutMs}ms.`)),
            this.options.shutdownTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  currentStatus(): MobileSyncStatus {
    return { ...this.status };
  }

  runOnce(): Promise<MobileSyncStatus> {
    if (this.stopping) return Promise.resolve(this.currentStatus());
    if (this.currentRun) return this.currentRun;
    const controller = new AbortController();
    this.currentController = controller;
    this.currentRun = this.performRun(controller.signal).finally(() => {
      this.currentRun = null;
      if (this.currentController === controller) this.currentController = null;
    });
    return this.currentRun;
  }

  private async performRun(signal: AbortSignal): Promise<MobileSyncStatus> {
    try {
      throwIfAborted(signal);
      const now = this.options.now();
      const snapshot = await projectMobileWorkspace(this.store, now);
      throwIfAborted(signal);
      const shouldPush = snapshot.generation !== this.status.snapshotGeneration
        || now.getTime() - this.lastFullReconcileAt >= this.options.fullReconcileMs;
      if (shouldPush) {
        await this.client.replaceSnapshot(snapshot, signal);
        throwIfAborted(signal);
        this.lastFullReconcileAt = now.getTime();
        this.setStatus({
          ...this.status,
          enabled: true,
          snapshotGeneration: snapshot.generation,
          lastPushAt: now.toISOString(),
        });
      }

      const progress = await this.commandProgress();
      throwIfAborted(signal);
      await this.client.syncCommandProgress(progress, signal);
      throwIfAborted(signal);
      const commands = await this.client.claimCommands(20, signal);
      throwIfAborted(signal);
      this.setStatus({ ...this.status, lastPullAt: now.toISOString() });
      for (const command of commands) {
        throwIfAborted(signal);
        let result: MobileCommandResult;
        try {
          result = await this.domain.applyMobileCommand(command);
          throwIfAborted(signal);
        } catch (error) {
          throwIfAborted(signal);
          await this.client.completeCommand(command.id, "rejected", {
            error: sanitizeText(error instanceof Error ? error.message : String(error)),
          }, signal);
          throwIfAborted(signal);
          continue;
        }
        await this.client.completeCommand(command.id, "applied", { workId: result.workId }, signal);
        throwIfAborted(signal);
      }
      if (commands.length) {
        const refreshed = await projectMobileWorkspace(this.store, this.options.now());
        throwIfAborted(signal);
        await this.client.replaceSnapshot(refreshed, signal);
        throwIfAborted(signal);
        this.lastFullReconcileAt = this.options.now().getTime();
        this.setStatus({
          ...this.status,
          snapshotGeneration: refreshed.generation,
          lastPushAt: this.options.now().toISOString(),
        });
      }
      this.setStatus({
        ...this.status,
        lastSuccessAt: this.options.now().toISOString(),
        lastError: undefined,
      });
    } catch (error) {
      if (!this.stopping) {
        this.setStatus({
          ...this.status,
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return this.currentStatus();
  }

  private async commandProgress(): Promise<MobileCommandProgress[]> {
    const progress: MobileCommandProgress[] = [];
    for (const feedId of await this.store.listFeedIds()) {
      for (const work of await this.store.readWorkItems(feedId)) {
        if (!work.sourceMobileCommandId) continue;
        progress.push({
          commandId: work.sourceMobileCommandId,
          workId: work.id,
          workStatus: work.status,
          ...(work.response ? { response: sanitizeText(work.response) } : {}),
          ...(work.error ? { error: sanitizeText(work.error) } : {}),
          updatedAt: work.updatedAt,
        });
      }
    }
    return progress;
  }

  private setStatus(status: MobileSyncStatus): void {
    this.status = status;
    this.options.onStatus?.(this.currentStatus());
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Mobile sync stopped before the operation could safely continue.");
}
