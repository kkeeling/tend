import { describe, expect, test } from "bun:test";
import { createFeedEventBridge } from "../server/realtime/feedEventBridge";
import { createLocalRuntime } from "../server/runtime";
import { createRefreshCoalescer } from "../src/state/realtime";
import type { FeedEvent } from "../shared/types";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";

describe("feed event bridge", () => {
  test("notifies when durable feed events are appended after the initial seed", async () => {
    const events: FeedEvent[] = [
      { id: "evt_1", feedId: "inbox", type: "feed.created", at: "2026-06-05T18:00:00.000Z" },
    ];
    const notifications: unknown[] = [];
    const bridge = createFeedEventBridge(
      {
        async listFeedIds() {
          return ["inbox"];
        },
        async readEvents(feedId: string) {
          return events.filter((event) => event.feedId === feedId);
        },
      },
      (data) => notifications.push(data),
    );

    await bridge.poll();
    expect(notifications).toHaveLength(0);

    events.push({ id: "evt_2", feedId: "inbox", type: "card.created", at: "2026-06-05T18:01:00.000Z" });
    await bridge.poll();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ source: "feed-events", priorityScheduleChanged: false });
  });

  test("uses one authoritative cursor transition for an in-process mutation", async () => {
    let cursor = "generation-1";
    const notifications: unknown[] = [];
    const bridge = createFeedEventBridge(
      {
        async listFeedIds() {
          return ["inbox"];
        },
        async readEvents() {
          return [];
        },
        async readEventCursor() {
          return cursor;
        },
      },
      (data) => notifications.push(data),
    );

    await bridge.poll();
    cursor = "generation-2";
    await bridge.requestPoll();
    expect(notifications).toHaveLength(1);

    // The interval bridge observes the cursor already acknowledged by the
    // mutation path, so it cannot emit a duplicate doorbell later.
    await bridge.poll();
    expect(notifications).toHaveLength(1);
  });

  test("takes a trailing snapshot when a mutation arrives during a cursor poll", async () => {
    let cursor = "generation-1";
    let reads = 0;
    let releaseStaleRead: (() => void) | undefined;
    let staleReadStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { staleReadStarted = resolve; });
    const notifications: unknown[] = [];
    const bridge = createFeedEventBridge(
      {
        async listFeedIds() {
          return ["inbox"];
        },
        async readEvents() {
          return [];
        },
        async readEventCursor() {
          reads += 1;
          const snapshot = cursor;
          if (reads === 2) {
            staleReadStarted?.();
            await new Promise<void>((resolve) => { releaseStaleRead = resolve; });
          }
          return snapshot;
        },
      },
      (data) => notifications.push(data),
    );

    await bridge.poll();
    const stalePoll = bridge.poll();
    await started;
    cursor = "generation-2";
    const mutationPoll = bridge.requestPoll();
    releaseStaleRead?.();
    await Promise.all([stalePoll, mutationPoll]);

    expect(reads).toBe(3);
    expect(notifications).toHaveLength(1);
  });

  test("notifies when Chronicle publishes a new On Your Mind update", async () => {
    let contextCursor = "1:2026-06-13T18:00:00.000Z:mind-1";
    const notifications: unknown[] = [];
    const bridge = createFeedEventBridge(
      {
        async listFeedIds() {
          return [];
        },
        async readEvents() {
          return [];
        },
        async readMindContextCursor() {
          return contextCursor;
        },
      },
      (data) => notifications.push(data),
    );

    await bridge.poll();
    expect(notifications).toHaveLength(0);

    contextCursor = "2:2026-06-13T19:00:00.000Z:mind-2";
    await bridge.poll();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ source: "feed-events", priorityScheduleChanged: false });
  });

  test("notifies when an out-of-process priority mutation changes its durable schedule cursor", async () => {
    let priorityCursor = "priority-v1";
    const notifications: unknown[] = [];
    const bridge = createFeedEventBridge(
      {
        async listFeedIds() {
          return [];
        },
        async readEvents() {
          return [];
        },
        async readPriorityScheduleCursor() {
          return priorityCursor;
        },
      },
      (data) => notifications.push(data),
    );

    await bridge.poll();
    expect(notifications).toHaveLength(0);

    priorityCursor = "priority-v2";
    await bridge.poll();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ source: "feed-events", priorityScheduleChanged: true });
  });

  test("a second runtime mutation advances the production SQLite cursor and wakes the bridge", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tend-realtime-generation-"));
    const dataDir = path.join(root, "data");
    const dbPath = path.join(root, "attention.db");
    const serviceRuntime = await createLocalRuntime(dataDir, dbPath);
    const cliRuntime = await createLocalRuntime(dataDir, dbPath, { mode: "fast" });
    const notifications: unknown[] = [];
    const bridge = createFeedEventBridge(serviceRuntime.store, (data) => notifications.push(data));
    try {
      await bridge.poll();
      const before = await serviceRuntime.store.readPriorityScheduleCursor();
      await new AttentionDomain(cliRuntime.store).upsertCard("company-attention", {
        id: "external-priority-input",
        title: "External priority mutation",
        why: "This mutation came from another runtime handle.",
        blocks: [],
      });
      expect(await serviceRuntime.store.readPriorityScheduleCursor()).not.toBe(before);
      await bridge.poll();
      expect(notifications).toHaveLength(1);
    } finally {
      await bridge.stop();
      cliRuntime.sqlite.close({ checkpoint: false });
      serviceRuntime.sqlite.close({ checkpoint: false });
      await rm(root, { recursive: true, force: true });
    }
  });

  test("payload-only attention edits do not advance the priority schedule cursor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tend-priority-generation-"));
    const runtime = await createLocalRuntime(path.join(root, "data"), path.join(root, "attention.db"));
    const domain = new AttentionDomain(runtime.store);
    try {
      await domain.upsertCard("company-attention", {
        id: "copy-only",
        title: "Original copy",
        why: "Only presentation text will change.",
        blocks: [],
      });
      const before = await runtime.store.readPriorityScheduleCursor();
      await domain.upsertCard("company-attention", {
        id: "copy-only",
        title: "Revised copy",
        why: "Only presentation text changed.",
        blocks: [],
      });
      expect(await runtime.store.readPriorityScheduleCursor()).toBe(before);
    } finally {
      runtime.sqlite.close({ checkpoint: false });
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stop waits for an in-flight poll and suppresses its late notification", async () => {
    let readCount = 0;
    let releaseRead: (() => void) | undefined;
    const events: FeedEvent[] = [
      { id: "evt_1", feedId: "inbox", type: "feed.created", at: "2026-06-05T18:00:00.000Z" },
    ];
    const notifications: unknown[] = [];
    const bridge = createFeedEventBridge(
      {
        async listFeedIds() {
          return ["inbox"];
        },
        async readEvents() {
          readCount += 1;
          if (readCount > 1) await new Promise<void>((resolve) => { releaseRead = resolve; });
          return events;
        },
      },
      (data) => notifications.push(data),
      { intervalMs: 60_000 },
    );

    await bridge.start();
    events.push({ id: "evt_2", feedId: "inbox", type: "card.created", at: "2026-06-05T18:01:00.000Z" });
    const poll = bridge.poll();
    await Promise.resolve();
    let stopped = false;
    const stop = bridge.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseRead?.();
    await Promise.all([poll, stop]);
    expect(stopped).toBe(true);
    expect(notifications).toHaveLength(0);
  });

  test("stop cancels a requested trailing snapshot after the active poll drains", async () => {
    let reads = 0;
    let releaseRead: (() => void) | undefined;
    const bridge = createFeedEventBridge(
      {
        async listFeedIds() {
          return ["inbox"];
        },
        async readEvents() {
          return [];
        },
        async readEventCursor() {
          reads += 1;
          if (reads === 2) await new Promise<void>((resolve) => { releaseRead = resolve; });
          return String(reads);
        },
      },
      () => {},
    );

    await bridge.poll();
    const active = bridge.poll();
    await Promise.resolve();
    const requested = bridge.requestPoll();
    const stopped = bridge.stop();
    releaseRead?.();
    await Promise.all([active, requested, stopped]);

    expect(reads).toBe(2);
  });

  test("reports interval poll failures instead of silently leaving realtime stale", async () => {
    let fail = false;
    const errors: unknown[] = [];
    const bridge = createFeedEventBridge(
      {
        async listFeedIds() {
          if (fail) throw new Error("cursor read failed");
          return [];
        },
        async readEvents() {
          return [];
        },
      },
      () => {},
      { intervalMs: 5, onError: (error) => errors.push(error) },
    );
    await bridge.start();
    fail = true;
    await Bun.sleep(20);
    expect(errors.length).toBeGreaterThan(0);
    await bridge.stop();
  });

  test("commits no cursors when one feed read fails, then reports the preserved change on recovery", async () => {
    const cursors = new Map([["inbox", "1"], ["company-attention", "1"]]);
    let failCompany = false;
    const notifications: unknown[] = [];
    const bridge = createFeedEventBridge(
      {
        async listFeedIds() {
          return ["inbox", "company-attention"];
        },
        async readEvents() {
          return [];
        },
        async readEventCursor(feedId) {
          if (feedId === "company-attention" && failCompany) throw new Error("cursor unavailable");
          return cursors.get(feedId) ?? "0";
        },
      },
      (value) => notifications.push(value),
    );

    await bridge.poll();
    cursors.set("inbox", "2");
    failCompany = true;
    await expect(bridge.poll()).rejects.toThrow("cursor unavailable");
    expect(notifications).toHaveLength(0);
    failCompany = false;
    await bridge.poll();
    expect(notifications).toHaveLength(1);
  });

  test("reports feed removal as a visible realtime transition", async () => {
    let feedIds = ["inbox", "company-attention"];
    const notifications: unknown[] = [];
    const bridge = createFeedEventBridge(
      {
        async listFeedIds() {
          return feedIds;
        },
        async readEvents() {
          return [];
        },
        async readEventCursor() {
          return "1";
        },
      },
      (value) => notifications.push(value),
    );

    await bridge.poll();
    feedIds = ["inbox"];
    await bridge.poll();
    expect(notifications).toHaveLength(1);
  });
});

describe("browser realtime refresh scheduling", () => {
  test("aborts a stalled active refresh so the final refresh starts within 250ms", async () => {
    let calls = 0;
    let abortActive: (() => void) | undefined;
    let cancellationFinished = false;
    const scheduler = createRefreshCoalescer(
      async () => {
        calls += 1;
        if (calls === 1) await new Promise<void>((resolve) => { abortActive = resolve; });
      },
      {
        cancelActive: async () => {
          abortActive?.();
          await Promise.resolve();
          cancellationFinished = true;
        },
      },
    );

    const startedAt = performance.now();
    const active = scheduler.request();
    await Promise.resolve();
    scheduler.request();
    await active;

    expect(calls).toBe(2);
    expect(cancellationFinished).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(250);
    scheduler.dispose();
  });

  test("runs one active refresh and one trailing refresh for a burst", async () => {
    const releases: Array<() => void> = [];
    let calls = 0;
    const scheduler = createRefreshCoalescer(async () => {
      calls += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
    });

    scheduler.request();
    await Promise.resolve();
    for (let index = 0; index < 20; index += 1) scheduler.request();
    expect(calls).toBe(1);

    releases.shift()?.();
    await Bun.sleep(0);
    expect(calls).toBe(2);

    scheduler.request();
    releases.shift()?.();
    await Bun.sleep(0);
    expect(calls).toBe(3);

    releases.shift()?.();
    scheduler.dispose();
  });
});
