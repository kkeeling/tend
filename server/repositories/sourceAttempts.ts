import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SourceAttempt } from "../../shared/types";
import type { MirrorWriteCoordinator } from "./mirrorWrites";

export interface SourceAttemptRepository {
  init(feedIds: string[]): Promise<void>;
  list(feedId: string, sourceId?: string): Promise<SourceAttempt[]>;
  append(attempt: SourceAttempt): Promise<void>;
}

export class FileSourceAttemptRepository implements SourceAttemptRepository {
  constructor(private readonly dataDir: string) {}

  async init(_feedIds: string[]): Promise<void> {}

  async list(feedId: string, sourceId?: string): Promise<SourceAttempt[]> {
    const file = this.file(feedId);
    if (!existsSync(file)) return [];
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    const attempts = lines.map((line) => JSON.parse(line) as SourceAttempt);
    return attempts.filter((attempt) => sourceId === undefined || attempt.sourceId === sourceId);
  }

  async append(attempt: SourceAttempt): Promise<void> {
    const existing = await this.list(attempt.feedId);
    if (existing.some((item) => item.id === attempt.id)) return;
    const file = this.file(attempt.feedId);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(attempt)}\n`, "utf8");
  }

  private file(feedId: string): string {
    return path.join(this.dataDir, "feeds", feedId, "source-attempts.jsonl");
  }
}

export class MirroredSourceAttemptRepository implements SourceAttemptRepository {
  constructor(
    private readonly primary: SourceAttemptRepository,
    private readonly mirror: SourceAttemptRepository,
    private readonly mirrorWrites?: MirrorWriteCoordinator,
  ) {}

  async init(feedIds: string[]): Promise<void> {
    await this.mirror.init(feedIds);
    await this.primary.init(feedIds);
    for (const feedId of feedIds) await this.syncFeed(feedId);
  }

  list(feedId: string, sourceId?: string): Promise<SourceAttempt[]> {
    return this.primary.list(feedId, sourceId);
  }

  async append(attempt: SourceAttempt): Promise<void> {
    await this.primary.append(attempt);
    if (this.mirrorWrites) await this.mirrorWrites.write(() => this.mirror.append(attempt));
    else await this.mirror.append(attempt);
  }

  private async syncFeed(feedId: string): Promise<void> {
    const primary = await this.primary.list(feedId);
    const mirror = await this.mirror.list(feedId);
    const primaryIds = new Set(primary.map((item) => item.id));
    const mirrorIds = new Set(mirror.map((item) => item.id));
    for (const attempt of mirror.filter((item) => !primaryIds.has(item.id))) await this.primary.append(attempt);
    for (const attempt of primary.filter((item) => !mirrorIds.has(item.id))) await this.mirror.append(attempt);
  }
}
