import { expect, test } from "bun:test";
import { Hono } from "hono";
import { request } from "node:http";
import { createRealtimeHub } from "../server/routes/realtime";

test("SSE changes flush immediately instead of waiting for the connection heartbeat", async () => {
  const hub = createRealtimeHub();
  const app = new Hono();
  app.route("/", hub.routes());
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: app.fetch,
  });
  const frames: string[] = [];
  let buffer = "";
  let wake: (() => void) | null = null;
  const connection = request(`http://127.0.0.1:${server.port}/api/events`, (response) => {
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      buffer += chunk;
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        frames.push(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
      wake?.();
      wake = null;
    });
  });
  connection.end();
  const waitFor = async (event: string) => {
    const deadline = performance.now() + 1_000;
    while (!frames.some((frame) => frame.includes(`event: ${event}`))) {
      if (performance.now() >= deadline) throw new Error(`Timed out waiting for SSE ${event}.`);
      await Promise.race([
        new Promise<void>((resolve) => { wake = resolve; }),
        Bun.sleep(25),
      ]);
    }
  };

  try {
    await waitFor("ready");
    const startedAt = performance.now();
    hub.notify({ changedAt: "2026-07-26T12:00:00.000Z" });
    await waitFor("change");
    expect(performance.now() - startedAt).toBeLessThan(250);
  } finally {
    connection.destroy();
    server.stop(true);
  }
});
