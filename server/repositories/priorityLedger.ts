import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PriorityLedgerEntry } from "../../shared/types";
import type { MirrorWriteCoordinator } from "./mirrorWrites";
import { appendPrivateText } from "../util";

export interface PriorityLedgerRepository { init(): Promise<void>; list(): Promise<PriorityLedgerEntry[]>; append(entry: PriorityLedgerEntry): Promise<void>; }
export class FilePriorityLedgerRepository implements PriorityLedgerRepository {
  constructor(private readonly dataDir: string) {}
  async init(): Promise<void> {}
  async list(): Promise<PriorityLedgerEntry[]> {
    if (!existsSync(this.file())) return [];
    return (await readFile(this.file(), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as PriorityLedgerEntry);
  }
  async append(entry: PriorityLedgerEntry): Promise<void> {
    if ((await this.list()).some((item) => item.id === entry.id)) return;
    await appendPrivateText(this.file(), `${JSON.stringify(entry)}\n`);
  }
  private file(): string { return path.join(this.dataDir, "workspace", "priority", "ledger.jsonl"); }
}
export class MirroredPriorityLedgerRepository implements PriorityLedgerRepository {
  constructor(private readonly primary: PriorityLedgerRepository, private readonly mirror: PriorityLedgerRepository, private readonly mirrorWrites?: MirrorWriteCoordinator) {}
  async init(): Promise<void> {
    await this.mirror.init(); await this.primary.init(); const primary = await this.primary.list(); const mirror = await this.mirror.list();
    const primaryIds = new Set(primary.map((item) => item.id)); const mirrorIds = new Set(mirror.map((item) => item.id));
    for (const item of mirror.filter((entry) => !primaryIds.has(entry.id))) await this.primary.append(item);
    for (const item of primary.filter((entry) => !mirrorIds.has(entry.id))) await this.mirror.append(item);
  }
  list(): Promise<PriorityLedgerEntry[]> { return this.primary.list(); }
  async append(entry: PriorityLedgerEntry): Promise<void> { await this.primary.append(entry); if (this.mirrorWrites) await this.mirrorWrites.write(() => this.mirror.append(entry)); else await this.mirror.append(entry); }
}
