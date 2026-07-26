import { afterEach, describe, expect, test } from "bun:test";
import { localRead } from "../src/app/api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("browser API cancellation", () => {
  test("local authenticated reads preserve caller headers and the exact AbortSignal", async () => {
    const controller = new AbortController();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "/api/session") {
        return Response.json({ mutationToken: "local-token" });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    await localRead("/api/workspace/now", {
      signal: controller.signal,
      headers: { "x-test-context": "preserved" },
    });

    const request = calls.find((call) => call.url === "/api/workspace/now");
    const session = calls.find((call) => call.url === "/api/session");
    expect(session?.init?.signal).toBe(controller.signal);
    expect(request?.init?.signal).toBe(controller.signal);
    const headers = new Headers(request?.init?.headers);
    expect(headers.get("x-attention-read-token")).toBe("local-token");
    expect(headers.get("x-test-context")).toBe("preserved");
  });

  test("local reads rotate a stale cached token once after a service restart", async () => {
    const controller = new AbortController();
    const readCalls: RequestInit[] = [];
    let rejected = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/session") return Response.json({ mutationToken: "rotated-token" });
      readCalls.push(init ?? {});
      if (!rejected) {
        rejected = true;
        return Response.json({ error: "stale local token" }, { status: 403 });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    await expect(localRead("/api/workspace/now-surface", {
      signal: controller.signal,
      headers: { "x-test-context": "preserved" },
    })).resolves.toEqual({ ok: true });

    expect(readCalls).toHaveLength(2);
    expect(readCalls.every((call) => call.signal === controller.signal)).toBe(true);
    const retriedHeaders = new Headers(readCalls[1]?.headers);
    expect(retriedHeaders.get("x-attention-read-token")).toBe("rotated-token");
    expect(retriedHeaders.get("x-test-context")).toBe("preserved");
  });
});
