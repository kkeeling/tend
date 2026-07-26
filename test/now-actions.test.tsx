import { afterEach, beforeEach, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { WorkspaceControlPlane } from "../shared/types";
import { ControlPlaneApp } from "../src/workspace/ControlPlaneApp";
import { registerHappyDom } from "./happy-dom";

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
registerHappyDom();

class StubEventSource {
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();
  constructor() {
    queueMicrotask(() => {
      for (const listener of this.listeners.get("ready") ?? []) listener(new Event("ready"));
    });
  }
  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  close() {}
}

Object.assign(globalThis, { EventSource: StubEventSource });
beforeEach(() => Object.assign(globalThis, { EventSource: StubEventSource }));
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
});

test("Now permits only one in-flight request for a rapidly repeated card action", async () => {
  const surface: Pick<WorkspaceControlPlane, "now" | "coverage"> = {
    now: {
      asOf: "2026-07-26T12:00:00.000Z",
      allClear: false,
      message: "1 item needs attention.",
      items: [{
        id: "company-attention:prepare-holds",
        cardRef: { feedId: "company-attention", cardId: "prepare-holds" },
        card: {
          id: "prepare-holds",
          feedId: "company-attention",
          kind: "attention",
          status: "to_review_new",
          title: "Prepare the calendar holds",
          eyebrow: "Company attention",
          why: "A calendar follow-up is ready to prepare.",
          blocks: [],
          actions: [{
            id: "prepare-calendar-holds",
            label: "Prepare the calendar holds",
            behavior: "queue_instruction",
            instruction: "Prepare the holds without creating events.",
            variant: "primary",
          }, {
            id: "dismiss-card",
            label: "Dismiss card",
            behavior: "dismiss_card",
            variant: "secondary",
          }],
          readyForPass: 1,
          createdAt: "2026-07-26T12:00:00.000Z",
          updatedAt: "2026-07-26T12:00:00.000Z",
          history: [],
        },
        priority: { rank: 1, score: 900, explanation: "Due soon." },
      }],
    },
    coverage: {
      asOf: "2026-07-26T12:00:00.000Z",
      allClear: true,
      requiredSources: 0,
      freshRequiredSources: 0,
      caveat: "Coverage complete.",
      sources: [],
    },
  };
  let actionRequests = 0;
  let releaseAction: (() => void) | undefined;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/session") return Response.json({ mutationToken: "test-token" });
    if (url === "/api/workspace/now-surface") return Response.json(surface);
    if (init?.method === "POST" && url.endsWith("/actions/prepare-calendar-holds")) {
      actionRequests += 1;
      await new Promise<void>((resolve) => { releaseAction = resolve; });
      return Response.json({ id: "work-1", status: "queued" });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const nowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/now",
    component: () => <ControlPlaneApp surface="now" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([nowRoute]),
    history: createMemoryHistory({ initialEntries: ["/now"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const action = await view.findByRole("button", { name: "Prepare the calendar holds" });
  const alternateAction = view.getByRole("button", { name: "Dismiss card" });
  fireEvent.click(action);
  fireEvent.click(action);
  fireEvent.click(alternateAction);

  await waitFor(() => {
    expect(actionRequests).toBe(1);
    expect((action as HTMLButtonElement).disabled).toBe(true);
    expect((alternateAction as HTMLButtonElement).disabled).toBe(true);
    expect(action.getAttribute("aria-busy")).toBe("true");
  });

  releaseAction?.();
  await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
});

test("an ambiguous action failure stays locked until read-only canonical inspection succeeds", async () => {
  const surface: Pick<WorkspaceControlPlane, "now" | "coverage"> = {
    now: {
      asOf: "2026-07-26T12:00:00.000Z",
      allClear: false,
      message: "1 item needs attention.",
      items: [{
        id: "company-attention:ambiguous",
        cardRef: { feedId: "company-attention", cardId: "ambiguous" },
        card: {
          id: "ambiguous",
          feedId: "company-attention",
          kind: "attention",
          status: "to_review_new",
          title: "Ambiguous action",
          eyebrow: "Company attention",
          why: "The response may be lost after commit.",
          blocks: [],
          actions: [{ id: "prepare", label: "Prepare", behavior: "queue_instruction", instruction: "Prepare it." }],
          readyForPass: 1,
          createdAt: "2026-07-26T12:00:00.000Z",
          updatedAt: "2026-07-26T12:00:00.000Z",
          history: [],
        },
        priority: { rank: 1, score: 900, explanation: "Due soon." },
      }],
    },
    coverage: {
      asOf: "2026-07-26T12:00:00.000Z",
      allClear: true,
      requiredSources: 0,
      freshRequiredSources: 0,
      caveat: "Coverage complete.",
      sources: [],
    },
  };
  let reads = 0;
  let allowInspection = false;
  let actionRequests = 0;
  let actionStarted = false;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/session") return Response.json({ mutationToken: "test-token" });
    if (url === "/api/workspace/now-surface") {
      reads += 1;
      if (actionStarted && !allowInspection) throw new TypeError("connection reset after response");
      return Response.json(surface);
    }
    if (url === "/api/workspace/coverage") return Response.json(surface.coverage);
    if (init?.method === "POST" && url.endsWith("/actions/prepare")) {
      actionRequests += 1;
      actionStarted = true;
      throw new TypeError("connection reset after request");
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const nowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/now",
    component: () => <ControlPlaneApp surface="now" />,
  });
  const coverageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/coverage",
    component: () => <ControlPlaneApp surface="coverage" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([nowRoute, coverageRoute]),
    history: createMemoryHistory({ initialEntries: ["/now"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const action = await view.findByRole("button", { name: "Prepare" });
  fireEvent.click(action);
  await view.findByText("A change result needs read-only verification before this control can be used again.");
  expect((action as HTMLButtonElement).disabled).toBe(true);
  expect(actionRequests).toBe(1);

  await router.navigate({ to: "/coverage" });
  await view.findByRole("heading", { name: "Coverage" });
  await router.navigate({ to: "/now" });
  const actionAfterNavigation = await view.findByRole("button", { name: "Prepare" });
  expect((actionAfterNavigation as HTMLButtonElement).disabled).toBe(true);
  expect(actionRequests).toBe(1);

  allowInspection = true;
  fireEvent.click(view.getByRole("button", { name: "Refresh and inspect" }));
  await waitFor(() => expect((actionAfterNavigation as HTMLButtonElement).disabled).toBe(false));
  expect(actionRequests).toBe(1);
});
