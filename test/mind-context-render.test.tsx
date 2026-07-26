import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MindRefreshStatus, OnYourMindContent } from "../src/mind/OnYourMindPage";
import type { MindContextWorkspace } from "../shared/types";

test("renders a fresh On Your Mind workspace with excerpts and expandable filtered OCR", () => {
  const workspace: MindContextWorkspace = {
    health: "fresh",
    binding: { publisherThreadId: "thread-chronicle", boundAt: "2026-06-13T16:00:00.000Z" },
    current: {
      id: "mind-current",
      sourceThreadId: "thread-chronicle",
      state: "fresh",
      publishedAt: "2026-06-13T16:50:00.000Z",
      observedFrom: "2026-06-13T16:35:00.000Z",
      observedTo: "2026-06-13T16:45:00.000Z",
      freshUntil: "2026-06-13T19:50:00.000Z",
      summary: "Paywall diagnosis is the main active question.",
      signals: [{
        id: "paywall",
        kind: "changed_now",
        title: "Paywall diagnosis",
        summary: "The work shifted from pausing the experiment to improving the experience.",
        observationIds: ["obs-paywall", "obs-two", "obs-three", "obs-four"],
      }],
      observations: [{
        id: "obs-paywall",
        kind: "chronicle_ocr",
        title: "Paywall working session",
        app: "Codex",
        observedFrom: "2026-06-13T16:35:00.000Z",
        observedTo: "2026-06-13T16:45:00.000Z",
        excerpt: "Investigating mobile CTA visibility and lost pricing context.",
        fullText: "Complete privacy-filtered OCR window.",
        redactionCount: 1,
      }, ...["two", "three", "four"].map((id) => ({
        id: `obs-${id}`,
        kind: "source_receipt" as const,
        title: `Source ${id}`,
        observedFrom: "2026-06-13T16:35:00.000Z",
        observedTo: "2026-06-13T16:45:00.000Z",
        excerpt: `Excerpt ${id}.`,
      }))],
      contentDigest: "digest",
      lastFreshUpdateId: "mind-current",
    },
    lastFresh: null,
    history: [{
      id: "mind-current",
      state: "fresh",
      publishedAt: "2026-06-13T16:50:00.000Z",
      observedFrom: "2026-06-13T16:35:00.000Z",
      observedTo: "2026-06-13T16:45:00.000Z",
      summary: "Paywall diagnosis is the main active question.",
      signalCount: 1,
      sourceCount: 4,
    }],
  };

  const html = renderToStaticMarkup(<OnYourMindContent workspace={workspace} busy />);

  expect(html).toContain("On Your Mind");
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain("Changed now");
  expect(html).toContain("Investigating mobile CTA visibility");
  expect(html).toContain("Full filtered window");
  expect(html).toContain("Complete privacy-filtered OCR window.");
  expect(html).toContain("1 redaction");
  expect(html).toContain('id="signal-paywall"');
  expect(html).toContain("Show 1 more source observation");
  expect(html).not.toContain("Excerpt four.");
  expect(html).toContain('href="/mind/mind-current"');
});

test("distinguishes query failures from realtime reconnection and exposes retry state", () => {
  const failed = renderToStaticMarkup(
    <MindRefreshStatus error={new Error("Mind context request timed out")} busy onRetry={() => {}} />,
  );
  expect(failed).toContain('role="alert"');
  expect(failed).toContain("Mind context request timed out");
  expect(failed).toContain("Refreshing…");
  expect(failed).toContain("disabled");
  expect(failed).not.toContain("while Tend reconnects");

  const reconnecting = renderToStaticMarkup(
    <MindRefreshStatus busy={false} onRetry={() => {}} />,
  );
  expect(reconnecting).toContain('role="status"');
  expect(reconnecting).toContain("while Tend reconnects");
  expect(reconnecting).toContain(">Retry<");
});

test("labels a card-linked historical pulse without presenting it as current", () => {
  const workspace: MindContextWorkspace = {
    health: "fresh",
    binding: { publisherThreadId: "thread-chronicle", boundAt: "2026-06-13T16:00:00.000Z" },
    current: {
      id: "mind-historical",
      sourceThreadId: "thread-chronicle",
      state: "fresh",
      publishedAt: "2026-06-10T16:50:00.000Z",
      observedFrom: "2026-06-10T16:35:00.000Z",
      observedTo: "2026-06-10T16:45:00.000Z",
      freshUntil: "2026-06-10T19:50:00.000Z",
      summary: "An earlier decision context.",
      signals: [{
        id: "earlier",
        kind: "changed_now",
        title: "Earlier signal",
        summary: "This is the exact signal that influenced the card.",
        observationIds: ["earlier-source"],
      }],
      observations: [{
        id: "earlier-source",
        kind: "source_receipt",
        title: "Earlier source",
        observedFrom: "2026-06-10T16:35:00.000Z",
        observedTo: "2026-06-10T16:45:00.000Z",
        excerpt: "Historical source excerpt.",
      }],
      contentDigest: "digest",
      lastFreshUpdateId: "mind-historical",
    },
    lastFresh: null,
    history: [],
  };

  const html = renderToStaticMarkup(<OnYourMindContent workspace={workspace} historical />);

  expect(html).toContain("Historical pulse");
  expect(html).toContain("Originally fresh until");
  expect(html).toContain("Historical source excerpt.");
});
