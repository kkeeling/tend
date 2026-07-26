import { afterEach, beforeEach, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { Card, WorkspaceControlPlane, WorkspaceNowItem } from "../shared/types";
import { ControlPlaneApp } from "../src/workspace/ControlPlaneApp";
import { createWorkspaceContinuityStore } from "../src/workspace/continuityStore";
import { registerHappyDom } from "./happy-dom";

registerHappyDom();

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

class ReadyEventSource {
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor() {
    queueMicrotask(() => {
      for (const listener of this.listeners.get("ready") ?? []) listener();
    });
  }

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close() {}
}

beforeEach(() => Object.assign(globalThis, { EventSource: ReadyEventSource }));
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
});

function item(id: string, options: { status?: Card["status"]; blockValue?: string; actionLabel?: string } = {}): WorkspaceNowItem {
  const status = options.status ?? "to_review_new";
  return {
    id: `company-attention:${id}`,
    cardRef: { feedId: "company-attention", cardId: id },
    card: {
      id,
      feedId: "company-attention",
      kind: "attention",
      status,
      title: `Card ${id}`,
      eyebrow: "Company attention",
      why: "Continuity fixture.",
      blocks: options.blockValue === undefined
        ? []
        : [{ id: "draft", type: "editable_text", label: "Draft", value: options.blockValue, editable: true }],
      actions: status === "to_review_new" || status === "to_review_updated"
        ? [{
            id: `act-${id}`,
            label: options.actionLabel ?? `Act ${id}`,
            behavior: "queue_instruction",
            instruction: `Act on ${id}.`,
            variant: "primary",
          }]
        : [],
      readyForPass: 1,
      createdAt: "2026-07-26T12:00:00.000Z",
      updatedAt: "2026-07-26T12:00:00.000Z",
      history: [],
    },
    priority: { rank: 1, score: 900, explanation: "Due soon." },
  };
}

function surface(items: WorkspaceNowItem[]): Pick<WorkspaceControlPlane, "now" | "coverage"> {
  return {
    now: {
      asOf: "2026-07-26T12:00:00.000Z",
      allClear: false,
      message: `${items.length} item${items.length === 1 ? "" : "s"} need attention.`,
      items,
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
}

function renderNow(queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
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
  return {
    queryClient,
    view: render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  };
}

test("continuity storage never silently evicts unresolved drafts", () => {
  const store = createWorkspaceContinuityStore();
  for (let index = 0; index < 150; index += 1) {
    store.setInstructionDraft(`instruction-${index}`, `Unsent instruction ${index}`);
    store.setArtifactDraft(`artifact-${index}`, {
      value: `Local edit ${index}`,
      baseValue: `Server value ${index}`,
      conflictingServerValue: null,
    });
  }

  expect(store.instructionDrafts.get("instruction-0")).toBe("Unsent instruction 0");
  expect(store.artifactDrafts.get("artifact-0")?.value).toBe("Local edit 0");
  expect(store.instructionDrafts.size).toBe(150);
  expect(store.artifactDrafts.size).toBe(150);
});

test("each concurrent card mutation gets a canonical inspection that starts after its own commit", async () => {
  const current = surface([
    item("one", { actionLabel: "Act one" }),
    { ...item("two", { actionLabel: "Act two" }), priority: { rank: 2, score: 800, explanation: "Next." } },
  ]);
  let trackInspections = false;
  let actionPosts = 0;
  let inspections = 0;
  let releaseFirstInspection: (() => void) | undefined;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/session") return Response.json({ mutationToken: "test-token" });
    if (url === "/api/workspace/now-surface") {
      if (trackInspections) {
        inspections += 1;
        if (inspections === 1) {
          await new Promise<void>((resolve) => { releaseFirstInspection = resolve; });
        }
      }
      return Response.json(current);
    }
    if (init?.method === "POST" && url.includes("/actions/")) {
      actionPosts += 1;
      return Response.json({ id: `work-${actionPosts}`, status: "queued" });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const { view } = renderNow();
  const first = await view.findByRole("button", { name: "Act one" });
  const second = await view.findByRole("button", { name: "Act two" });
  await waitFor(() => expect((first as HTMLButtonElement).disabled).toBe(false));
  trackInspections = true;

  fireEvent.click(first);
  await waitFor(() => expect(inspections).toBe(1));
  fireEvent.click(second);
  await waitFor(() => expect(actionPosts).toBe(2));
  expect(inspections).toBe(1);

  releaseFirstInspection?.();
  await waitFor(() => expect(inspections).toBe(2));
});

test("a server refresh preserves a dirty card draft and gates actions until conflict resolution", async () => {
  const initial = surface([item("conflict", { blockValue: "Original", actionLabel: "Send draft" })]);
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url === "/api/session") return Response.json({ mutationToken: "test-token" });
    if (url === "/api/workspace/now-surface") return Response.json(initial);
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const { view, queryClient } = renderNow();
  const editor = await view.findByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement;
  const action = view.getByRole("button", { name: "Send draft" }) as HTMLButtonElement;
  await waitFor(() => expect(action.disabled).toBe(false));
  fireEvent.input(editor, { target: { value: "My local edit" } });

  const remote = surface([{
    ...initial.now.items[0],
    card: {
      ...initial.now.items[0].card,
      blocks: [{ id: "draft", type: "editable_text", label: "Draft", value: "Remote edit", editable: true }],
      updatedAt: "2026-07-26T12:01:00.000Z",
    },
  }]);
  act(() => queryClient.setQueryData(["workspace-control-plane", "now-surface"], remote));

  await view.findByText("Tend received a newer version while you were editing.");
  expect(editor.value).toBe("My local edit");
  expect(action.disabled).toBe(true);

  fireEvent.click(view.getByRole("button", { name: "Keep my edit" }));
  await waitFor(() => expect(action.disabled).toBe(false));
  expect(editor.value).toBe("My local edit");
});

test("a response-lost workspace instruction keeps its draft until canonical state proves the queue", async () => {
  const initial = surface([item("instruction", { actionLabel: "Act instruction" })]);
  const committedItem = {
    ...initial.now.items[0],
    card: {
      ...initial.now.items[0].card,
      status: "queued" as const,
      actions: [],
      history: [{
        at: "2026-07-26T12:01:00.000Z",
        type: "user.scoped_instruction" as const,
        detail: "Please prepare the follow-up.",
      }],
    },
  };
  const committed = surface([committedItem]);
  let instructionStarted = false;
  let inspectionStarted = false;
  let releaseInspection: (() => void) | undefined;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/session") return Response.json({ mutationToken: "test-token" });
    if (url === "/api/workspace/now-surface") {
      if (instructionStarted) {
        inspectionStarted = true;
        await new Promise<void>((resolve) => { releaseInspection = resolve; });
        return Response.json(committed);
      }
      return Response.json(initial);
    }
    if (url === "/api/workspace/instructions" && init?.method === "POST") {
      instructionStarted = true;
      throw new TypeError("connection reset after commit");
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const { view } = renderNow();
  const editor = await view.findByRole("textbox", { name: "Card instruction" }) as HTMLTextAreaElement;
  fireEvent.input(editor, { target: { value: "Please prepare the follow-up." } });
  fireEvent.click(view.getByRole("button", { name: "Send" }));

  await waitFor(() => expect(inspectionStarted).toBe(true));
  expect(editor.value).toBe("Please prepare the follow-up.");
  expect(view.getByRole("button", { name: "Sending…" })).toBeDefined();

  releaseInspection?.();
  await waitFor(() => expect(editor.value).toBe(""));
  await view.findByText("Queued for company-attention");
});

test("an unsent instruction remains recoverable when the selected card disappears", async () => {
  const first = item("removed");
  const second = { ...item("remaining"), priority: { rank: 2, score: 800, explanation: "Next." } };
  const initial = surface([first, second]);
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url === "/api/session") return Response.json({ mutationToken: "test-token" });
    if (url === "/api/workspace/now-surface") return Response.json(initial);
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const { view, queryClient } = renderNow();
  const editor = await view.findByRole("textbox", { name: "Card instruction" }) as HTMLTextAreaElement;
  fireEvent.input(editor, { target: { value: "Do not lose this thought." } });

  act(() => queryClient.setQueryData(
    ["workspace-control-plane", "now-surface"],
    surface([{ ...second, priority: { ...second.priority, rank: 1 } }]),
  ));

  await view.findByText("An unsent instruction from the previous card was preserved.");
  expect(editor.value).toBe("");
  fireEvent.click(view.getByRole("button", { name: "Restore for review" }));
  expect(editor.value).toBe("Do not lose this thought.");
});
