import { mkdir } from "node:fs/promises";
import path from "node:path";
import { attentionDataDir, attentionDbPath, attentionHome } from "./paths";
import { FileCardRepository, MirroredCardRepository } from "./repositories/cards";
import { FileFeedEventRepository, MirroredFeedEventRepository } from "./repositories/feedEvents";
import { FileMindContextRepository, MirroredMindContextRepository } from "./repositories/mindContext";
import { FileMobileCommandReceiptRepository, MirroredMobileCommandReceiptRepository } from "./repositories/mobileCommandReceipts";
import { MirrorWriteCoordinator } from "./repositories/mirrorWrites";
import { FileRevisionRepository, MirroredRevisionRepository } from "./repositories/revisions";
import { FileRoutineActionGroupRepository, MirroredRoutineActionGroupRepository } from "./repositories/routineActionGroups";
import { FileSourceRunRepository, MirroredSourceRunRepository } from "./repositories/sourceRuns";
import { FileSourceAttemptRepository, MirroredSourceAttemptRepository } from "./repositories/sourceAttempts";
import { FileSourceRepository, MirroredSourceRepository } from "./repositories/sources";
import { FileSweepRepository, MirroredSweepRepository } from "./repositories/sweeps";
import { FileTextDocumentRepository, MirroredTextDocumentRepository } from "./repositories/textDocuments";
import { FileWorkItemRepository, MirroredWorkItemRepository } from "./repositories/workItems";
import { FileWorkspaceFeedRepository, MirroredWorkspaceFeedRepository } from "./repositories/workspaceFeeds";
import { FileCommitmentCandidateRepository, MirroredCommitmentCandidateRepository } from "./repositories/commitmentCandidates";
import { FileCommitmentEventRepository, MirroredCommitmentEventRepository } from "./repositories/commitmentEvents";
import { FileWorkspaceCommitmentRepository, MirroredWorkspaceCommitmentRepository } from "./repositories/workspaceCommitments";
import { FilePriorityRuleRepository, MirroredPriorityRuleRepository } from "./repositories/priorityRules";
import { FilePriorityLedgerRepository, MirroredPriorityLedgerRepository } from "./repositories/priorityLedger";
import { FileWorkspaceNowProjectionRepository, MirroredWorkspaceNowProjectionRepository } from "./repositories/workspaceNowProjection";
import { LocalSqliteStore } from "./sqlite";
import { AttentionStore } from "./store";

export function resolveRuntimeRoot(_appRoot?: string): string {
  return attentionHome();
}

export function resolveDataDir(appRoot?: string): string {
  return appRoot ? path.join(resolveRuntimeRoot(appRoot), "data") : attentionDataDir();
}

export function resolveDbPath(appRoot?: string): string {
  return appRoot ? path.join(resolveRuntimeRoot(appRoot), "attention.db") : attentionDbPath();
}

export function resolveArtifactsDir(appRoot?: string): string {
  return path.join(resolveRuntimeRoot(appRoot), "output");
}

export async function createLocalRuntime(
  dataDir = resolveDataDir(),
  dbPath = path.join(path.dirname(dataDir), "attention.db"),
): Promise<{ dataDir: string; sqlite: LocalSqliteStore; store: AttentionStore }> {
  await mkdir(dataDir, { recursive: true });
  const sqlite = new LocalSqliteStore(dbPath);
  await sqlite.init();
  const mirrorWrites = new MirrorWriteCoordinator();
  const workspaceFeeds = new MirroredWorkspaceFeedRepository(
    sqlite.workspaceFeeds(),
    new FileWorkspaceFeedRepository(path.join(dataDir, "workspace.json")),
  );
  const commitmentCandidates = new MirroredCommitmentCandidateRepository(
    sqlite.commitmentCandidates(),
    new FileCommitmentCandidateRepository(dataDir),
  );
  const commitmentEvents = new MirroredCommitmentEventRepository(
    sqlite.commitmentEvents(),
    new FileCommitmentEventRepository(dataDir),
    mirrorWrites,
  );
  const workspaceCommitments = new MirroredWorkspaceCommitmentRepository(
    sqlite.workspaceCommitments(),
    new FileWorkspaceCommitmentRepository(dataDir),
  );
  const priorityRules = new MirroredPriorityRuleRepository(sqlite.priorityRules(), new FilePriorityRuleRepository(dataDir));
  const priorityLedger = new MirroredPriorityLedgerRepository(sqlite.priorityLedger(), new FilePriorityLedgerRepository(dataDir), mirrorWrites);
  const workspaceNowProjection = new MirroredWorkspaceNowProjectionRepository(sqlite.workspaceNowProjection(), new FileWorkspaceNowProjectionRepository(dataDir));
  const events = new MirroredFeedEventRepository(
    sqlite.feedEvents(),
    new FileFeedEventRepository(dataDir),
    mirrorWrites,
  );
  const mindContext = new MirroredMindContextRepository(
    sqlite.mindContext(),
    new FileMindContextRepository(dataDir),
  );
  const mobileCommandReceipts = new MirroredMobileCommandReceiptRepository(
    sqlite.mobileCommandReceipts(),
    new FileMobileCommandReceiptRepository(dataDir),
    mirrorWrites,
  );
  const revisions = new MirroredRevisionRepository(
    sqlite.revisions(),
    new FileRevisionRepository(dataDir),
  );
  const workItems = new MirroredWorkItemRepository(
    sqlite.workItems(),
    new FileWorkItemRepository(dataDir),
    mirrorWrites,
  );
  const cards = new MirroredCardRepository(
    sqlite.cards(),
    new FileCardRepository(dataDir),
    mirrorWrites,
  );
  const routineActionGroups = new MirroredRoutineActionGroupRepository(
    sqlite.routineActionGroups(),
    new FileRoutineActionGroupRepository(dataDir),
    mirrorWrites,
  );
  const sourceRuns = new MirroredSourceRunRepository(
    sqlite.sourceRuns(),
    new FileSourceRunRepository(dataDir),
  );
  const sourceAttempts = new MirroredSourceAttemptRepository(
    sqlite.sourceAttempts(),
    new FileSourceAttemptRepository(dataDir),
    mirrorWrites,
  );
  const sources = new MirroredSourceRepository(
    sqlite.sources(),
    new FileSourceRepository(dataDir),
  );
  const sweeps = new MirroredSweepRepository(
    sqlite.sweeps(),
    new FileSweepRepository(dataDir),
    mirrorWrites,
  );
  const textDocuments = new MirroredTextDocumentRepository(
    sqlite.textDocuments(),
    new FileTextDocumentRepository(dataDir),
  );
  const store = new AttentionStore(dataDir, {
    cards,
    commitmentCandidates,
    commitmentEvents,
    events,
    mindContext,
    mobileCommandReceipts,
    revisions,
    priorityLedger,
    priorityRules,
    routineActionGroups,
    runAtomic: (callback) => mirrorWrites.transaction(() => sqlite.transaction(callback)),
    sourceAttempts,
    sourceRuns,
    sources,
    sweeps,
    textDocuments,
    workItems,
    workspaceCommitments,
    workspaceFeeds,
    workspaceNowProjection,
  });
  await store.init();
  return { dataDir, sqlite, store };
}
