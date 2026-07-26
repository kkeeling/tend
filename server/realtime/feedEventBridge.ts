import type { FeedEvent } from "../../shared/types";
import { feedEventCursor } from "../repositories/feedEvents";
import { mapWithConcurrency } from "../util";

type FeedEventReader = {
  listFeedIds(): Promise<string[]>;
  readEvents(feedId: string): Promise<FeedEvent[]>;
  readEventCursor?(feedId: string): Promise<string>;
  readMindContextCursor?(): Promise<string>;
  readPriorityScheduleCursor?(): Promise<string>;
};

type Notify = (data: unknown) => void;

export function createFeedEventBridge(
  store: FeedEventReader,
  notify: Notify,
  options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
) {
  const cursors = new Map<string, string>();
  let mindContextCursor = "";
  let priorityScheduleCursor = "";
  const intervalMs = options.intervalMs ?? 1_000;
  let seeded = false;
  let stopped = false;
  let currentPoll: Promise<void> | null = null;
  let requestedPollVersion = 0;
  let completedRequestedPollVersion = 0;
  let requestedPollLoop: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function pollOnce(): Promise<void> {
    const feedIds = await store.listFeedIds();
    const [feedCursorEntries, nextMindContextCursor, nextPriorityScheduleCursor] = await Promise.all([
      mapWithConcurrency(feedIds, 16, async (feedId) => [
        feedId,
        store.readEventCursor
          ? await store.readEventCursor(feedId)
          : feedEventCursor(await store.readEvents(feedId)),
      ] as const),
      store.readMindContextCursor
        ? store.readMindContextCursor()
        : Promise.resolve(mindContextCursor),
      store.readPriorityScheduleCursor
        ? store.readPriorityScheduleCursor()
        : Promise.resolve(priorityScheduleCursor),
    ]);
    const nextCursors = new Map(feedCursorEntries);
    const feedChanged = seeded && (
      nextCursors.size !== cursors.size
      || [...nextCursors].some(([feedId, cursor]) => cursors.get(feedId) !== cursor)
    );
    const mindContextChanged = seeded && nextMindContextCursor !== mindContextCursor;
    const priorityScheduleChanged = seeded && nextPriorityScheduleCursor !== priorityScheduleCursor;

    cursors.clear();
    for (const [feedId, cursor] of nextCursors) cursors.set(feedId, cursor);
    mindContextCursor = nextMindContextCursor;
    priorityScheduleCursor = nextPriorityScheduleCursor;
    seeded = true;
    if (!stopped && (feedChanged || mindContextChanged || priorityScheduleChanged)) {
      notify({
        changedAt: new Date().toISOString(),
        source: "feed-events",
        priorityScheduleChanged,
      });
    }
  }

  function poll(): Promise<void> {
    if (currentPoll) return currentPoll;
    currentPoll = pollOnce().finally(() => {
      currentPoll = null;
    });
    return currentPoll;
  }

  function requestPoll(): Promise<void> {
    requestedPollVersion += 1;
    if (requestedPollLoop) return requestedPollLoop;

    requestedPollLoop = (async () => {
      while (!stopped && completedRequestedPollVersion < requestedPollVersion) {
        const targetVersion = requestedPollVersion;
        const pollAlreadyInFlight = currentPoll;
        if (pollAlreadyInFlight) await pollAlreadyInFlight;
        if (stopped) break;
        // Always take a fresh snapshot after a poll that was already running when the
        // request arrived. Its snapshot may have preceded the committed mutation.
        await poll();
        completedRequestedPollVersion = targetVersion;
      }
    })().finally(() => {
      requestedPollLoop = null;
    });
    return requestedPollLoop;
  }

  return {
    async start(): Promise<void> {
      stopped = false;
      await poll();
      timer = setInterval(() => void poll().catch((error) => {
        try {
          options.onError?.(error);
        } catch (handlerError) {
          console.error("[realtime] bridge error handler failed:", handlerError);
        }
      }), intervalMs);
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      await Promise.all([currentPoll, requestedPollLoop]);
    },
    poll,
    requestPoll,
  };
}
