import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

export function createRealtimeHub() {
  const listeners = new Set<(data: unknown) => void>();

  return {
    notify(data: unknown): void {
      for (const send of listeners) send(data);
    },
    routes(): Hono {
      const app = new Hono();
      app.get("/api/events", (c) =>
        streamSSE(c, async (stream) => {
          const pending: unknown[] = [];
          let wake: (() => void) | null = null;
          const enqueue = (data: unknown) => {
            pending[0] = data;
            pending.length = 1;
            wake?.();
            wake = null;
          };
          listeners.add(enqueue);
          try {
            await stream.writeSSE({ event: "ready", data: "{}" });
            while (!stream.closed) {
              if (pending.length === 0) {
                await Promise.race([
                  new Promise<void>((resolve) => { wake = resolve; }),
                  stream.sleep(15_000),
                ]);
                wake = null;
              }
              if (stream.closed) break;
              const next = pending.shift();
              if (next !== undefined) await stream.writeSSE({ event: "change", data: JSON.stringify(next) });
            }
          } finally {
            listeners.delete(enqueue);
          }
        }),
      );
      return app;
    },
  };
}
