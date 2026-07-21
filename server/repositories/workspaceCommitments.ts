import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceCommitment } from "../../shared/types";
import { readJson, writeJson } from "../util";

export interface WorkspaceCommitmentRepository {
  init(): Promise<void>;
  list(): Promise<WorkspaceCommitment[]>;
  get(id: string): Promise<WorkspaceCommitment>;
  findByDeduplicationKey(key: string): Promise<WorkspaceCommitment | null>;
  write(commitment: WorkspaceCommitment, expectedVersion?: number): Promise<void>;
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
  private dir(): string { return path.join(this.dataDir, "workspace", "commitments"); }
  private file(id: string): string { return path.join(this.dir(), `${id}.json`); }
}

export class MirroredWorkspaceCommitmentRepository implements WorkspaceCommitmentRepository {
  constructor(private readonly primary: WorkspaceCommitmentRepository, private readonly mirror: WorkspaceCommitmentRepository) {}
  async init(): Promise<void> {
    await this.mirror.init(); await this.primary.init();
    const primary = await this.primary.list(); const mirror = await this.mirror.list();
    const primaryIds = new Set(primary.map((item) => item.id)); const mirrorIds = new Set(mirror.map((item) => item.id));
    for (const item of mirror.filter((candidate) => !primaryIds.has(candidate.id))) await this.primary.write(item);
    for (const item of primary.filter((candidate) => !mirrorIds.has(candidate.id))) await this.mirror.write(item);
  }
  list(): Promise<WorkspaceCommitment[]> { return this.primary.list(); }
  get(id: string): Promise<WorkspaceCommitment> { return this.primary.get(id); }
  findByDeduplicationKey(key: string): Promise<WorkspaceCommitment | null> { return this.primary.findByDeduplicationKey(key); }
  async write(commitment: WorkspaceCommitment, expectedVersion?: number): Promise<void> {
    await this.primary.write(commitment, expectedVersion); await this.mirror.write(commitment);
  }
}
