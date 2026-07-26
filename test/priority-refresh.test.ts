import { describe, expect, test } from "bun:test";
import { PriorityRefreshWorker } from "../server/priorityRefresh";
import { nextPriorityBoundaryAt } from "../server/workflow/priority";

describe("scheduled priority refresh", () => {
  test("notifies only when a manual refresh changes the persisted projection", async () => {
    let changed = false;
    const notifications: unknown[] = [];
    const worker = new PriorityRefreshWorker(
      {
        async refreshWorkspacePrioritiesWithResult() {
          const result = { changed };
          changed = false;
          return result;
        },
        async nextWorkspacePriorityBoundary() {
          return null;
        },
      },
      (value) => notifications.push(value),
    );

    await worker.runOnce();
    expect(notifications).toHaveLength(0);
    changed = true;
    await worker.runOnce();
    expect(notifications).toHaveLength(1);
    await worker.runOnce();
    expect(notifications).toHaveLength(1);
    await worker.stop();
  });

  test("does not finish a committed refresh before its durable notification settles", async () => {
    let releaseNotification: (() => void) | undefined;
    let finished = false;
    const worker = new PriorityRefreshWorker(
      {
        async refreshWorkspacePrioritiesWithResult() {
          return { changed: true };
        },
        async nextWorkspacePriorityBoundary() {
          return null;
        },
      },
      async () => new Promise<void>((resolve) => { releaseNotification = resolve; }),
    );

    const refresh = worker.runOnce().then(() => { finished = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    releaseNotification?.();
    await refresh;
    expect(finished).toBe(true);
    await worker.stop();
  });

  test("stop awaits the active pass and suppresses its late notification", async () => {
    const notifications: unknown[] = [];
    let release: (() => void) | undefined;
    const worker = new PriorityRefreshWorker(
      {
        async refreshWorkspacePrioritiesWithResult() {
          await new Promise<void>((resolve) => { release = resolve; });
          return { changed: true };
        },
        async nextWorkspacePriorityBoundary() {
          return null;
        },
      },
      (value) => notifications.push(value),
    );

    const refresh = worker.runOnce();
    await Promise.resolve();
    let stopped = false;
    const stop = worker.stop().then(() => { stopped = true; });
    expect(stopped).toBe(false);
    release?.();
    await Promise.all([refresh, stop]);
    expect(notifications).toHaveLength(0);
  });

  test("arms one exact boundary instead of polling when no time input can change", async () => {
    const notifications: unknown[] = [];
    let boundary: Date | null = new Date(Date.now() + 10);
    let refreshes = 0;
    const worker = new PriorityRefreshWorker(
      {
        async refreshWorkspacePrioritiesWithResult() {
          refreshes += 1;
          boundary = null;
          return { changed: false };
        },
        async nextWorkspacePriorityBoundary() {
          return boundary;
        },
      },
      (value) => notifications.push(value),
    );

    worker.start();
    await Bun.sleep(30);
    expect(refreshes).toBe(1);
    expect(notifications).toHaveLength(1);
    await worker.stop();
  });

  test("contains a scheduling failure and retries without an unhandled rejection", async () => {
    const errors: unknown[] = [];
    let scheduleAttempts = 0;
    const worker = new PriorityRefreshWorker(
      {
        async refreshWorkspacePrioritiesWithResult() {
          return { changed: false };
        },
        async nextWorkspacePriorityBoundary() {
          scheduleAttempts += 1;
          if (scheduleAttempts === 1) throw new Error("temporary schedule failure");
          return null;
        },
      },
      () => {},
      { onError: (error) => errors.push(error), retryMs: 5 },
    );

    await worker.start();
    expect(errors).toHaveLength(1);
    await Bun.sleep(20);
    expect(scheduleAttempts).toBeGreaterThanOrEqual(2);
    expect(errors).toHaveLength(1);
    await worker.stop();
  });

  test("retries the failed refresh itself instead of only recomputing its schedule", async () => {
    let refreshAttempts = 0;
    const errors: unknown[] = [];
    const worker = new PriorityRefreshWorker(
      {
        async refreshWorkspacePrioritiesWithResult() {
          refreshAttempts += 1;
          if (refreshAttempts === 1) throw new Error("temporary projection failure");
          return { changed: true };
        },
        async nextWorkspacePriorityBoundary() {
          return null;
        },
      },
      () => {},
      { onError: (error) => errors.push(error), retryMs: 5 },
    );

    await worker.runOnce();
    await Bun.sleep(20);
    expect(refreshAttempts).toBe(2);
    expect(errors).toHaveLength(1);
    await worker.stop();
  });

  test("computes the next transition using the priority engine's minute bands", () => {
    const dueAt = "2026-07-27T12:00:00.000Z";
    const now = new Date("2026-07-20T10:00:00.000Z");
    expect(nextPriorityBoundaryAt([dueAt], 30, now)?.toISOString())
      .toBe("2026-07-20T11:59:00.001Z");
    expect(nextPriorityBoundaryAt([], 30, now)).toBeNull();
  });
});
