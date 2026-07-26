import { expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { RealtimeProvider } from "../src/state/realtime";
import { registerHappyDom } from "./happy-dom";

registerHappyDom();

class ControlledEventSource {
  static current: ControlledEventSource | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor() {
    ControlledEventSource.current = this;
  }

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  close() {}
}

test("SSE ready keeps actions reconnecting until its canonical refresh completes", async () => {
  const originalEventSource = globalThis.EventSource;
  Object.assign(globalThis, { EventSource: ControlledEventSource });
  let releaseRefresh: (() => void) | undefined;
  let refreshes = 0;
  const view = render(
    <RealtimeProvider
      enabled
      onChange={async () => {
        refreshes += 1;
        await new Promise<void>((resolve) => { releaseRefresh = resolve; });
      }}
    >
      {({ state }) => <span>{state}</span>}
    </RealtimeProvider>,
  );
  try {
    expect(view.getByText("connecting")).toBeDefined();
    act(() => ControlledEventSource.current?.emit("ready"));
    expect(view.getByText("reconnecting")).toBeDefined();
    expect(refreshes).toBe(1);
    act(() => releaseRefresh?.());
    await waitFor(() => expect(view.getByText("live")).toBeDefined());

    act(() => ControlledEventSource.current?.onerror?.());
    expect(view.getByText("reconnecting")).toBeDefined();
    act(() => ControlledEventSource.current?.emit("ready"));
    expect(view.getByText("reconnecting")).toBeDefined();
  } finally {
    view.unmount();
    cleanup();
    globalThis.EventSource = originalEventSource;
  }
});

test("SSE changes stay gated until canonical refresh succeeds", async () => {
  const originalEventSource = globalThis.EventSource;
  Object.assign(globalThis, { EventSource: ControlledEventSource });
  let refreshes = 0;
  let rejectRefresh: ((error: Error) => void) | undefined;
  const view = render(
    <RealtimeProvider
      enabled
      onChange={async () => {
        refreshes += 1;
        if (refreshes === 2) {
          await new Promise<void>((_resolve, reject) => { rejectRefresh = reject; });
        }
      }}
    >
      {({ state }) => <span>{state}</span>}
    </RealtimeProvider>,
  );
  try {
    act(() => ControlledEventSource.current?.emit("ready"));
    await waitFor(() => expect(view.getByText("live")).toBeDefined());
    act(() => ControlledEventSource.current?.onerror?.());
    expect(view.getByText("reconnecting")).toBeDefined();

    act(() => ControlledEventSource.current?.emit("change"));
    expect(view.getByText("reconnecting")).toBeDefined();
    act(() => rejectRefresh?.(new Error("refresh failed")));
    await waitFor(() => expect(view.getByText("reconnecting")).toBeDefined());

    act(() => ControlledEventSource.current?.emit("change"));
    await waitFor(() => expect(view.getByText("live")).toBeDefined());
  } finally {
    view.unmount();
    cleanup();
    globalThis.EventSource = originalEventSource;
  }
});
