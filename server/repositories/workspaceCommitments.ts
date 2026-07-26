import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceCommitment } from "../../shared/types";
import type { MirrorWriteCoordinator } from "./mirrorWrites";
import { readJson, writeJson } from "../util";

export interface WorkspaceCommitmentRepository {
  init(): Promise<void>;
  list(): Promise<WorkspaceCommitment[]>;
  get(id: string): Promise<WorkspaceCommitment>;
  findByDeduplicationKey(key: string): Promise<WorkspaceCommitment | null>;
  write(commitment: WorkspaceCommitment, expectedVersion?: number): Promise<void>;
  remove?(id: string): Promise<void>;
}

export class FileWorkspaceCommitmentRepository implements WorkspaceCommitmentRepository {
  constructor(private readonly dataDir: string) {}
  async init(): Promise<void> {}
  async list(): Promise<WorkspaceCommitment[]> {
    const dir = this.dir();
    if (!existsSync(dir)) return [];
    return Promise.all((await readdir(dir)).filter((file) => file.endsWith(".json")).map((file) => readJson<WorkspaceCommitment>(path.join(dir, file))));
  }
  async get(id: string): Promise<WorkspaceCommitment> {
    if (!existsSync(this.file(id))) throw new Error(`Workspace commitment not found: ${id}`);
    return readJson<WorkspaceCommitment>(this.file(id));
  }
  async findByDeduplicationKey(key: string): Promise<WorkspaceCommitment | null> {
    return (await this.list()).find((item) => item.deduplicationKey === key) ?? null;
  }
  async write(commitment: WorkspaceCommitment, expectedVersion?: number): Promise<void> {
    const current = existsSync(this.file(commitment.id)) ? await this.get(commitment.id) : null;
    if (expectedVersion !== undefined && current?.version !== expectedVersion) throw new Error("Commitment version changed; refresh and retry.");
    await writeJson(this.file(commitment.id), commitment);
  }
  async remove(id: string): Promise<void> { await rm(this.file(id), { force: true }); }
  private dir(): string { return path.join(this.dataDir, "workspace", "commitments"); }
  private file(id: string): string { return path.join(this.dir(), `${id}.json`); }
}

export class MirroredWorkspaceCommitmentRepository implements WorkspaceCommitmentRepository {
  constructor(
    private readonly primary: WorkspaceCommitmentRepository,
    private readonly mirror: WorkspaceCommitmentRepository,
    private readonly mirrorWrites?: MirrorWriteCoordinator,
    private readonly primaryAuthoritative = false,
  ) {}
  async init(): Promise<void> {
    await this.primary.init(); await this.mirror.init();
    const primary = await this.primary.list(); const mirror = await this.mirror.list();
    const primaryIds = new Set(primary.map((item) => item.id));
    const mirrorIds = new Set(mirror.map((item) => item.id));
    if (this.primaryAuthoritative && this.mirror.remove) {
      for (const item of mirror.filter((commitment) => !primaryIds.has(commitment.id))) {
        await this.mirror.remove(item.id);
      }
    }
    for (const item of primary.filter((candidate) =>
      this.primaryAuthoritative || !mirrorIds.has(candidate.id))) {
      await this.mirror.write(item);
    }
  }
  list(): Promise<WorkspaceCommitment[]> { return this.primary.list(); }
  get(id: string): Promise<WorkspaceCommitment> { return this.primary.get(id); }
  findByDeduplicationKey(key: string): Promise<WorkspaceCommitment | null> { return this.primary.findByDeduplicationKey(key); }
  async write(commitment: WorkspaceCommitment, expectedVersion?: number): Promise<void> {
    await this.primary.write(commitment, expectedVersion);
    if (this.mirrorWrites) await this.mirrorWrites.write(() => this.mirror.write(commitment));
    else await this.mirror.write(commitment);
  }
}
