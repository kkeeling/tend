import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { apiRoutes } from "../server/routes/api";
import { AttentionStore } from "../server/store";

const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-workspace-control-"));
  roots.push(root);
  const store = new AttentionStore(root);
  await store.init();
  const domain = new AttentionDomain(store);
  await domain.createFeedFromBrief("Primary Work\nPrimary work.", null);
  await domain.createFeedFromBrief("Side Project\nSide project.", null);
  await domain.upsertCard("primary-work", { id: "shared", title: "Primary card", why: "Primary.", blocks: [{ id: "memo", type: "memo", text: "Primary." }] });
  await domain.upsertCard("side-project", { id: "shared", title: "Side card", why: "Side.", blocks: [{ id: "memo", type: "memo", text: "Side." }] });
  const app = apiRoutes({ artifactsDir: root, dataDir: root, domain, notify: () => {}, port: 0, root, sqlite: { status: () => ({ ok: true }) } as any, store, mutationToken: "test-token" });
  return { app, domain, store };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("workspace control plane parity", () => {
  test("keeps same-named cards isolated and withholds all-clear without required coverage", async () => {
    const { store } = await setup();
    const workspace = await store.readWorkspaceControlPlane(new Date("2026-07-21T18:00:00.000Z"));
    expect(workspace.now.items.filter((item) => item.card.id === "shared").map((item) => item.id)).toEqual([
      "primary-work:shared",
      "side-project:shared",
    ]);
    expect(workspace.now.allClear).toBe(false);
    expect(workspace.now.message).not.toContain("all required sources are coverage-complete");
  });

  test("HTTP exposes the canonical read model and routes instructions only to the owner feed", async () => {
    const { app, store } = await setup();
    const response = await app.request("/api/workspace/now", { headers: { "x-attention-read-token": "test-token" } });
    expect(response.status).toBe(200);
    const now = await response.json() as { items: Array<{ id: string }> };
    expect(now.items.map((item) => item.id)).toContain("side-project:shared");

    const queued = await app.request("/api/workspace/instructions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cardRef: { feedId: "side-project", cardId: "shared" }, instruction: "Handle the side-project item." }),
    });
    expect(queued.status).toBe(200);
    const bytes = await queued.text();
    expect(bytes).not.toContain("capabilityToken");
    expect((await store.readWorkItems("side-project"))).toHaveLength(1);
    expect((await store.readWorkItems("primary-work"))).toHaveLength(0);
  });

  test("workspace slice GETs are pure and do not rebuild the full control plane", async () => {
    const { app, domain, store } = await setup();
    const canonical = await store.readWorkspaceControlPlane(new Date("2026-07-21T18:00:00.000Z"));
    const refreshSpy = spyOn(domain, "refreshWorkspacePriorities").mockImplementation(async () => {
      throw new Error("read route attempted a priority mutation");
    });
    const nowSpy = spyOn(store, "readWorkspaceNow").mockImplementation(async () => canonical.now);
    const controlPlaneSpy = spyOn(store, "readWorkspaceControlPlane").mockImplementation(async () => {
      throw new Error("slice route rebuilt the full aggregate");
    });

    const response = await app.request("/api/workspace/now", {
      headers: { "x-attention-read-token": "test-token" },
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { items: unknown[] }).items).toHaveLength(2);
    expect(nowSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(controlPlaneSpy).not.toHaveBeenCalled();
  });

  test("Now surface returns attention and coverage from one shared coverage scan", async () => {
    const { app, store } = await setup();
    const canonical = await store.readWorkspaceControlPlane(new Date("2026-07-21T18:00:00.000Z"));
    const surfaceSpy = spyOn(store, "readWorkspaceNowSurface").mockImplementation(async () => {
      return { now: canonical.now, coverage: canonical.coverage };
    });
    const nowSpy = spyOn(store, "readWorkspaceNow").mockImplementation(async () => {
      throw new Error("Now surface performed a second attention read");
    });
    const coverageSpy = spyOn(store, "readWorkspaceCoverage").mockImplementation(async () => {
      throw new Error("Now surface performed a second coverage scan");
    });

    const response = await app.request("/api/workspace/now-surface", {
      headers: { "x-attention-read-token": "test-token" },
    });
    expect(response.status).toBe(200);
    const surface = await response.json() as { now: { items: unknown[] }; coverage: { sources: unknown[] } };
    expect(surface.now.items).toHaveLength(2);
    expect(surface.coverage.sources).toHaveLength(canonical.coverage.sources.length);
    expect(surfaceSpy).toHaveBeenCalledTimes(1);
    expect(nowSpy).not.toHaveBeenCalled();
    expect(coverageSpy).not.toHaveBeenCalled();
  });
});
