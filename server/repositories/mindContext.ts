import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { MindContextBinding, MindContextUpdate } from "../../shared/types";
import { readJson, writeJson } from "../util";

export interface MindContextRepository {
  init(): Promise<void>;
  readBinding(): Promise<MindContextBinding>;
  writeBinding(binding: MindContextBinding): Promise<void>;
  readCursor(): Promise<string>;
  listUpdates(): Promise<MindContextUpdate[]>;
  getUpdate(updateId: string): Promise<MindContextUpdate>;
  writeUpdate(update: MindContextUpdate): Promise<void>;
  removeUpdate(updateId: string): Promise<void>;
}

export function defaultMindContextBinding(): MindContextBinding {
  return { publisherThreadId: null, boundAt: null };
}

export class FileMindContextRepository implements MindContextRepository {
  constructor(private readonly dataDir: string) {}

  async init(): Promise<void> {
    if (!existsSync(this.bindingFile())) await this.writeBinding(defaultMindContextBinding());
  }

  async readBinding(): Promise<MindContextBinding> {
    if (!existsSync(this.bindingFile())) return defaultMindContextBinding();
    return readJson<MindContextBinding>(this.bindingFile());
  }

  async writeBinding(binding: MindContextBinding): Promise<void> {
    await writeJson(this.bindingFile(), binding);
  }

  async readCursor(): Promise<string> {
    const binding = await this.readBinding();
    const bindingCursor = `${binding.publisherThreadId ?? ""}:${binding.boundAt ?? ""}`;
    if (!existsSync(this.updatesPath())) return `${bindingCursor}:0:`;
    const files = (await readdir(this.updatesPath()))
      .filter((file) => file.endsWith(".json"))
      .sort();
    return `${bindingCursor}:${files.length}:${files.join("|")}`;
  }

  async listUpdates(): Promise<MindContextUpdate[]> {
    if (!existsSync(this.updatesPath())) return [];
    const files = (await readdir(this.updatesPath())).filter((file) => file.endsWith(".json"));
    const updates = await Promise.all(files.map((file) => readJson<MindContextUpdate>(path.join(this.updatesPath(), file))));
    return updates.sort((left, right) => left.publishedAt.localeCompare(right.publishedAt) || left.id.localeCompare(right.id));
  }

  async getUpdate(updateId: string): Promise<MindContextUpdate> {
    if (!existsSync(this.updateFile(updateId))) throw new Error(`Mind context update not found: ${updateId}`);
    return readJson<MindContextUpdate>(this.updateFile(updateId));
  }

  async writeUpdate(update: MindContextUpdate): Promise<void> {
    await writeJson(this.updateFile(update.id), update);
  }

  async removeUpdate(updateId: string): Promise<void> {
    await rm(this.updateFile(updateId), { force: true });
  }

  private bindingFile(): string {
    return path.join(this.dataDir, "mind-context", "binding.json");
  }

  private updatesPath(): string {
    return path.join(this.dataDir, "mind-context", "updates");
  }

  private updateFile(updateId: string): string {
    return path.join(this.updatesPath(), `${updateId}.json`);
  }
}

export class MirroredMindContextRepository implements MindContextRepository {
  constructor(
    private readonly primary: MindContextRepository,
    private readonly mirror: MindContextRepository,
    private readonly primaryAuthoritative = false,
  ) {}

  async init(): Promise<void> {
    await this.mirror.init();
    await this.primary.init();
    const [primaryBinding, mirrorBinding] = await Promise.all([this.primary.readBinding(), this.mirror.readBinding()]);
    if (!primaryBinding.publisherThreadId && mirrorBinding.publisherThreadId && !this.primaryAuthoritative) {
      await this.primary.writeBinding(mirrorBinding);
    }
    if ((this.primaryAuthoritative || primaryBinding.publisherThreadId) && (
      primaryBinding.publisherThreadId !== mirrorBinding.publisherThreadId ||
      primaryBinding.boundAt !== mirrorBinding.boundAt
    )) {
      await this.mirror.writeBinding(primaryBinding);
    }
    await this.syncUpdates();
  }

  readBinding(): Promise<MindContextBinding> {
    return this.primary.readBinding();
  }

  async writeBinding(binding: MindContextBinding): Promise<void> {
    await this.primary.writeBinding(binding);
    await this.mirror.writeBinding(binding);
  }

  readCursor(): Promise<string> {
    return this.primary.readCursor();
  }

  listUpdates(): Promise<MindContextUpdate[]> {
    return this.primary.listUpdates();
  }

  getUpdate(updateId: string): Promise<MindContextUpdate> {
    return this.primary.getUpdate(updateId);
  }

  async writeUpdate(update: MindContextUpdate): Promise<void> {
    await this.primary.writeUpdate(update);
    await this.mirror.writeUpdate(update);
  }

  async removeUpdate(updateId: string): Promise<void> {
    await this.mirror.removeUpdate(updateId);
    await this.primary.removeUpdate(updateId);
  }

  private async syncUpdates(): Promise<void> {
    const primary = await this.primary.listUpdates();
    const mirror = await this.mirror.listUpdates();
    const primaryIds = new Set(primary.map((update) => update.id));
    const mirrorIds = new Set(mirror.map((update) => update.id));
    for (const update of mirror.filter((item) => !primaryIds.has(item.id))) {
      if (this.primaryAuthoritative) await this.mirror.removeUpdate(update.id);
      else await this.primary.writeUpdate(update);
    }
    const mirrorById = new Map(mirror.map((update) => [update.id, update]));
    for (const update of primary.filter((item) =>
      !mirrorIds.has(item.id) || mirrorById.get(item.id)?.contentDigest !== item.contentDigest)) {
      await this.mirror.writeUpdate(update);
    }
  }
}
