import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { CommitmentEvent } from "../../shared/types";
import type { MirrorWriteCoordinator } from "./mirrorWrites";

export interface CommitmentEventRepository {
  init(): Promise<void>;
  list(commitmentId?: string): Promise<CommitmentEvent[]>;
  append(event: CommitmentEvent): Promise<void>;
}

export class FileCommitmentEventRepository implements CommitmentEventRepository {
  constructor(private readonly dataDir: string) {}
  async init(): Promise<void> {}
  async list(commitmentId?: string): Promise<CommitmentEvent[]> {
    const file = this.file(); if (!existsSync(file)) return [];
    const events = (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as CommitmentEvent);
    return events.filter((event) => commitmentId === undefined || event.commitmentId === commitmentId);
  }
  async append(event: CommitmentEvent): Promise<void> {
    if ((await this.list()).some((item) => item.id === event.id)) return;
    await mkdir(path.dirname(this.file()), { recursive: true });
    await appendFile(this.file(), `${JSON.stringify(event)}\n`, "utf8");
  }
  private file(): string { return path.join(this.dataDir, "workspace", "commitment-events.jsonl"); }
}

export class MirroredCommitmentEventRepository implements CommitmentEventRepository {
  constructor(private readonly primary: CommitmentEventRepository, private readonly mirror: CommitmentEventRepository, private readonly mirrorWrites?: MirrorWriteCoordinator) {}
  async init(): Promise<void> {
    await this.mirror.init(); await this.primary.init();
    const primary = await this.primary.list(); const mirror = await this.mirror.list();
    const primaryIds = new Set(primary.map((item) => item.id)); const mirrorIds = new Set(mirror.map((item) => item.id));
    for (const item of mirror.filter((event) => !primaryIds.has(event.id))) await this.primary.append(item);
    for (const item of primary.filter((event) => !mirrorIds.has(event.id))) await this.mirror.append(item);
  }
  list(commitmentId?: string): Promise<CommitmentEvent[]> { return this.primary.list(commitmentId); }
  async append(event: CommitmentEvent): Promise<void> {
    await this.primary.append(event);
    if (this.mirrorWrites) await this.mirrorWrites.write(() => this.mirror.append(event)); else await this.mirror.append(event);
  }
}
