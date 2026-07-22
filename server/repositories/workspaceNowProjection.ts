import { existsSync } from "node:fs";
import path from "node:path";
import type { WorkspaceNowRow } from "../../shared/types";
import type { MirrorWriteCoordinator } from "./mirrorWrites";
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
  constructor(
    private readonly primary: WorkspaceNowProjectionRepository,
    private readonly mirror: WorkspaceNowProjectionRepository,
    private readonly mirrorWrites?: MirrorWriteCoordinator,
  ) {}
  async init(): Promise<void> { await this.primary.init(); await this.mirror.init(); await this.mirror.replace(await this.primary.list()); }
  list(): Promise<WorkspaceNowRow[]> { return this.primary.list(); }
  async replace(rows: WorkspaceNowRow[]): Promise<void> {
    await this.primary.replace(rows);
    if (this.mirrorWrites) await this.mirrorWrites.write(() => this.mirror.replace(rows));
    else await this.mirror.replace(rows);
  }
}
