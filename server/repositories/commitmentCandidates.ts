import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { CommitmentCandidate } from "../../shared/types";
import type { MirrorWriteCoordinator } from "./mirrorWrites";
import { readJson, writeJson } from "../util";

export interface CommitmentCandidateRepository {
  init(): Promise<void>;
  list(): Promise<CommitmentCandidate[]>;
  get(id: string): Promise<CommitmentCandidate>;
  write(candidate: CommitmentCandidate): Promise<void>;
}

export class FileCommitmentCandidateRepository implements CommitmentCandidateRepository {
  constructor(private readonly dataDir: string) {}
  async init(): Promise<void> {}
  async list(): Promise<CommitmentCandidate[]> {
    const dir = this.dir();
    if (!existsSync(dir)) return [];
    return Promise.all((await readdir(dir)).filter((file) => file.endsWith(".json")).map((file) => readJson<CommitmentCandidate>(path.join(dir, file))));
  }
  async get(id: string): Promise<CommitmentCandidate> {
    if (!existsSync(this.file(id))) throw new Error(`Commitment candidate not found: ${id}`);
    return readJson<CommitmentCandidate>(this.file(id));
  }
  async write(candidate: CommitmentCandidate): Promise<void> { await writeJson(this.file(candidate.id), candidate); }
  private dir(): string { return path.join(this.dataDir, "workspace", "commitment-candidates"); }
  private file(id: string): string { return path.join(this.dir(), `${id}.json`); }
}

export class MirroredCommitmentCandidateRepository implements CommitmentCandidateRepository {
  constructor(
    private readonly primary: CommitmentCandidateRepository,
    private readonly mirror: CommitmentCandidateRepository,
    private readonly mirrorWrites?: MirrorWriteCoordinator,
  ) {}
  async init(): Promise<void> {
    await this.primary.init();
    await this.mirror.init();
    const primary = await this.primary.list();
    const mirror = await this.mirror.list();
    const mirrorIds = new Set(mirror.map((item) => item.id));
    for (const item of primary.filter((candidate) => !mirrorIds.has(candidate.id))) await this.mirror.write(item);
  }
  list(): Promise<CommitmentCandidate[]> { return this.primary.list(); }
  get(id: string): Promise<CommitmentCandidate> { return this.primary.get(id); }
  async write(candidate: CommitmentCandidate): Promise<void> {
    await this.primary.write(candidate);
    if (this.mirrorWrites) await this.mirrorWrites.write(() => this.mirror.write(candidate));
    else await this.mirror.write(candidate);
  }
}
