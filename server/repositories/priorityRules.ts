import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { PriorityRuleProposal, PriorityRuleSet } from "../../shared/types";
import type { MirrorWriteCoordinator } from "./mirrorWrites";
import { readJson, writeJson } from "../util";

export interface PriorityRuleRepository {
  init(): Promise<void>;
  listRuleSets(): Promise<PriorityRuleSet[]>;
  active(): Promise<PriorityRuleSet | null>;
  writeRuleSet(ruleSet: PriorityRuleSet): Promise<void>;
  listProposals(): Promise<PriorityRuleProposal[]>;
  getProposal(id: string): Promise<PriorityRuleProposal>;
  writeProposal(proposal: PriorityRuleProposal): Promise<void>;
}

export class FilePriorityRuleRepository implements PriorityRuleRepository {
  constructor(private readonly dataDir: string) {}
  async init(): Promise<void> {}
  async listRuleSets(): Promise<PriorityRuleSet[]> { return this.readDirectory<PriorityRuleSet>("rules"); }
  async active(): Promise<PriorityRuleSet | null> { return (await this.listRuleSets()).find((item) => item.status === "active") ?? null; }
  async writeRuleSet(ruleSet: PriorityRuleSet): Promise<void> { await writeJson(this.file("rules", ruleSet.id), ruleSet); }
  async listProposals(): Promise<PriorityRuleProposal[]> { return this.readDirectory<PriorityRuleProposal>("proposals"); }
  async getProposal(id: string): Promise<PriorityRuleProposal> {
    if (!existsSync(this.file("proposals", id))) throw new Error(`Priority rule proposal not found: ${id}`);
    return readJson<PriorityRuleProposal>(this.file("proposals", id));
  }
  async writeProposal(proposal: PriorityRuleProposal): Promise<void> { await writeJson(this.file("proposals", proposal.id), proposal); }
  private async readDirectory<T>(kind: string): Promise<T[]> {
    const dir = path.join(this.dataDir, "workspace", "priority", kind);
    if (!existsSync(dir)) return [];
    return Promise.all((await readdir(dir)).filter((file) => file.endsWith(".json")).map((file) => readJson<T>(path.join(dir, file))));
  }
  private file(kind: string, id: string): string { return path.join(this.dataDir, "workspace", "priority", kind, `${id}.json`); }
}

export class MirroredPriorityRuleRepository implements PriorityRuleRepository {
  constructor(
    private readonly primary: PriorityRuleRepository,
    private readonly mirror: PriorityRuleRepository,
    private readonly mirrorWrites?: MirrorWriteCoordinator,
  ) {}
  async init(): Promise<void> {
    await this.primary.init(); await this.mirror.init();
    const primaryRules = await this.primary.listRuleSets(); const mirrorRules = await this.mirror.listRuleSets();
    const mirrorRuleIds = new Set(mirrorRules.map((item) => item.id));
    for (const item of primaryRules.filter((rule) => !mirrorRuleIds.has(rule.id))) await this.mirror.writeRuleSet(item);
    const primaryProposals = await this.primary.listProposals(); const mirrorProposals = await this.mirror.listProposals();
    const mirrorProposalIds = new Set(mirrorProposals.map((item) => item.id));
    for (const item of primaryProposals.filter((proposal) => !mirrorProposalIds.has(proposal.id))) await this.mirror.writeProposal(item);
  }
  listRuleSets(): Promise<PriorityRuleSet[]> { return this.primary.listRuleSets(); }
  active(): Promise<PriorityRuleSet | null> { return this.primary.active(); }
  async writeRuleSet(ruleSet: PriorityRuleSet): Promise<void> {
    await this.primary.writeRuleSet(ruleSet);
    if (this.mirrorWrites) await this.mirrorWrites.write(() => this.mirror.writeRuleSet(ruleSet));
    else await this.mirror.writeRuleSet(ruleSet);
  }
  listProposals(): Promise<PriorityRuleProposal[]> { return this.primary.listProposals(); }
  getProposal(id: string): Promise<PriorityRuleProposal> { return this.primary.getProposal(id); }
  async writeProposal(proposal: PriorityRuleProposal): Promise<void> {
    await this.primary.writeProposal(proposal);
    if (this.mirrorWrites) await this.mirrorWrites.write(() => this.mirror.writeProposal(proposal));
    else await this.mirror.writeProposal(proposal);
  }
}
