import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SourceAttempt } from "../../shared/types";
import type { MirrorWriteCoordinator } from "./mirrorWrites";
import { appendPrivateText } from "../util";

export interface SourceAttemptRepository {
  init(feedIds: string[]): Promise<void>;
  list(feedId: string, sourceId?: string): Promise<SourceAttempt[]>;
  append(attempt: SourceAttempt): Promise<void>;
}

export class FileSourceAttemptRepository implements SourceAttemptRepository {
  private readonly seenIds = new Map<string, Promise<Set<string>>>();
  private readonly appendTails = new Map<string, Promise<void>>();

  constructor(private readonly dataDir: string) {}

  async init(feedIds: string[]): Promise<void> {
    await Promise.all(feedIds.map((feedId) => this.ids(feedId)));
  }

  async list(feedId: string, sourceId?: string): Promise<SourceAttempt[]> {
    const file = this.file(feedId);
    if (!existsSync(file)) return [];
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    const attempts = lines.map((line) => JSON.parse(line) as SourceAttempt);
    return attempts.filter((attempt) => sourceId === undefined || attempt.sourceId === sourceId);
  }

  async append(attempt: SourceAttempt): Promise<void> {
    const previous = this.appendTails.get(attempt.feedId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const ids = await this.ids(attempt.feedId);
      if (ids.has(attempt.id)) return;
      const file = this.file(attempt.feedId);
      await appendPrivateText(file, `${JSON.stringify(attempt)}\n`);
      ids.add(attempt.id);
    });
    this.appendTails.set(attempt.feedId, operation.catch(() => undefined));
    await operation;
  }

  private ids(feedId: string): Promise<Set<string>> {
    const cached = this.seenIds.get(feedId);
    if (cached) return cached;
    const loaded = this.list(feedId).then((attempts) => new Set(attempts.map((attempt) => attempt.id)));
    this.seenIds.set(feedId, loaded);
    return loaded;
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
    await this.primary.init(feedIds);
    await this.mirror.init(feedIds);
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
    const mirrorIds = new Set(mirror.map((item) => item.id));
    for (const attempt of primary.filter((item) => !mirrorIds.has(item.id))) await this.mirror.append(attempt);
  }
}
