import { expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useRefreshCoalescer } from "../src/state/realtime";
import { registerHappyDom } from "./happy-dom";

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
registerHappyDom();

test("ordinary rerenders preserve an active refresh and use the latest callback for the trailing pass", async () => {
  const calls: number[] = [];
  let releaseActive: (() => void) | undefined;
  let cancellations = 0;
  const hook = renderHook(
    ({ version }) => useRefreshCoalescer(
      async () => {
        calls.push(version);
        if (calls.length === 1) await new Promise<void>((resolve) => { releaseActive = resolve; });
      },
      () => {
        cancellations += 1;
        releaseActive?.();
      },
    ),
    { initialProps: { version: 1 } },
  );
  try {
    let active: Promise<void> = Promise.resolve();
    act(() => {
      active = hook.result.current();
    });
    await Promise.resolve();
    hook.rerender({ version: 2 });
    expect(cancellations).toBe(0);
    act(() => {
      void hook.result.current();
    });
    await active;

    expect(cancellations).toBe(1);
    expect(calls).toEqual([1, 2]);
  } finally {
    hook.unmount();
    cleanup();
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
  }
});
