import { existsSync } from "node:fs";
import path from "node:path";
import type { WorkspaceNowRow } from "../../shared/types";
import { readJson, writeJson } from "../util";

export interface WorkspaceNowProjectionRepository { init(): Promise<void>; list(): Promise<WorkspaceNowRow[]>; replace(rows: WorkspaceNowRow[]): Promise<void>; }
export class FileWorkspaceNowProjectionRepository implements WorkspaceNowProjectionRepository {
  constructor(private readonly dataDir: string) {}
  async init(): Promise<void> {}
  async list(): Promise<WorkspaceNowRow[]> { return existsSync(this.file()) ? readJson<WorkspaceNowRow[]>(this.file()) : []; }
  async replace(rows: WorkspaceNowRow[]): Promise<void> { await writeJson(this.file(), rows); }
  private file(): string { return path.join(this.dataDir, "workspace", "now-projection.json"); }
}
export class MirroredWorkspaceNowProjectionRepository implements WorkspaceNowProjectionRepository {
  constructor(private readonly primary: WorkspaceNowProjectionRepository, private readonly mirror: WorkspaceNowProjectionRepository) {}
  async init(): Promise<void> { await this.mirror.init(); await this.primary.init(); const primary = await this.primary.list(); const mirror = await this.mirror.list(); if (!primary.length && mirror.length) await this.primary.replace(mirror); else await this.mirror.replace(primary); }
  list(): Promise<WorkspaceNowRow[]> { return this.primary.list(); }
  async replace(rows: WorkspaceNowRow[]): Promise<void> { await this.primary.replace(rows); await this.mirror.replace(rows); }
}
