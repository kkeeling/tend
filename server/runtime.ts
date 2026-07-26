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
import { LocalSqliteStore, RuntimeBootstrapRequiredError } from "./sqlite";
import { AttentionStore } from "./store";
import { assertPrivateDirectory, configurePrivateProcessPermissions, ensurePrivateDirectory, hardenPrivateTree, MissingPrivateDirectoryError, PrivateDirectoryModeError } from "./util";

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
  options: { mode?: "bootstrap" | "fast"; repairMirrors?: boolean } = {},
): Promise<{ dataDir: string; sqlite: LocalSqliteStore; store: AttentionStore }> {
  configurePrivateProcessPermissions();
  const mode = options.mode ?? "bootstrap";
  const primaryAuthoritative = options.repairMirrors === true;
  const runtimeRoot = path.dirname(dataDir);
  const ownsRuntimeRoot = path.resolve(runtimeRoot) === path.resolve(attentionHome());
  if (mode === "bootstrap") {
    await ensurePrivateDirectory(runtimeRoot);
    await ensurePrivateDirectory(dataDir);
    await hardenPrivateTree(ownsRuntimeRoot ? runtimeRoot : dataDir);
  } else {
    try {
      await assertPrivateDirectory(runtimeRoot);
      await assertPrivateDirectory(dataDir);
    } catch (error) {
      if (error instanceof MissingPrivateDirectoryError || error instanceof PrivateDirectoryModeError) {
        throw new RuntimeBootstrapRequiredError();
      }
      throw error;
    }
  }
  const sqlite = new LocalSqliteStore(dbPath);
  try {
    if (mode === "fast") await sqlite.openReady();
    else await sqlite.init();
  } catch (error) {
    sqlite.close({ checkpoint: false });
    throw error;
  }
  const mirrorWrites = new MirrorWriteCoordinator(() => sqlite.markMirrorRepairRequired());
  const workspaceFeeds = new MirroredWorkspaceFeedRepository(
    sqlite.workspaceFeeds(),
    new FileWorkspaceFeedRepository(path.join(dataDir, "workspace.json")),
    primaryAuthoritative,
  );
  const commitmentCandidates = new MirroredCommitmentCandidateRepository(
    sqlite.commitmentCandidates(),
    new FileCommitmentCandidateRepository(dataDir),
    mirrorWrites,
    primaryAuthoritative,
  );
  const commitmentEvents = new MirroredCommitmentEventRepository(
    sqlite.commitmentEvents(),
    new FileCommitmentEventRepository(dataDir),
    mirrorWrites,
  );
  const workspaceCommitments = new MirroredWorkspaceCommitmentRepository(
    sqlite.workspaceCommitments(),
    new FileWorkspaceCommitmentRepository(dataDir),
    mirrorWrites,
    primaryAuthoritative,
  );
  const priorityRules = new MirroredPriorityRuleRepository(
    sqlite.priorityRules(),
    new FilePriorityRuleRepository(dataDir),
    mirrorWrites,
    primaryAuthoritative,
  );
  const priorityLedger = new MirroredPriorityLedgerRepository(sqlite.priorityLedger(), new FilePriorityLedgerRepository(dataDir), mirrorWrites);
  const workspaceNowProjection = new MirroredWorkspaceNowProjectionRepository(sqlite.workspaceNowProjection(), new FileWorkspaceNowProjectionRepository(dataDir), mirrorWrites);
  const events = new MirroredFeedEventRepository(
    sqlite.feedEvents(),
    new FileFeedEventRepository(dataDir),
    mirrorWrites,
    primaryAuthoritative,
  );
  const mindContext = new MirroredMindContextRepository(
    sqlite.mindContext(),
    new FileMindContextRepository(dataDir),
    primaryAuthoritative,
  );
  const mobileCommandReceipts = new MirroredMobileCommandReceiptRepository(
    sqlite.mobileCommandReceipts(),
    new FileMobileCommandReceiptRepository(dataDir),
    mirrorWrites,
  );
  const revisions = new MirroredRevisionRepository(
    sqlite.revisions(),
    new FileRevisionRepository(dataDir),
    primaryAuthoritative,
  );
  const workItems = new MirroredWorkItemRepository(
    sqlite.workItems(),
    new FileWorkItemRepository(dataDir),
    mirrorWrites,
    primaryAuthoritative,
  );
  const cards = new MirroredCardRepository(
    sqlite.cards(),
    new FileCardRepository(dataDir),
    mirrorWrites,
    primaryAuthoritative,
  );
  const routineActionGroups = new MirroredRoutineActionGroupRepository(
    sqlite.routineActionGroups(),
    new FileRoutineActionGroupRepository(dataDir),
    mirrorWrites,
    primaryAuthoritative,
  );
  const sourceRuns = new MirroredSourceRunRepository(
    sqlite.sourceRuns(),
    new FileSourceRunRepository(dataDir),
    mirrorWrites,
    primaryAuthoritative,
  );
  const sourceAttempts = new MirroredSourceAttemptRepository(
    sqlite.sourceAttempts(),
    new FileSourceAttemptRepository(dataDir),
    mirrorWrites,
  );
  const sources = new MirroredSourceRepository(
    sqlite.sources(),
    new FileSourceRepository(dataDir),
    mirrorWrites,
    primaryAuthoritative,
  );
  const sweeps = new MirroredSweepRepository(
    sqlite.sweeps(),
    new FileSweepRepository(dataDir),
    mirrorWrites,
    primaryAuthoritative,
  );
  const textDocuments = new MirroredTextDocumentRepository(
    sqlite.textDocuments(),
    new FileTextDocumentRepository(dataDir),
    primaryAuthoritative,
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
    readPriorityScheduleGeneration: () => sqlite.readPriorityScheduleGeneration(),
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
  if (mode === "bootstrap") {
    try {
      await store.init();
      if (!mirrorWrites.hasFailures()) sqlite.clearMirrorRepairRequired();
      await hardenPrivateTree(ownsRuntimeRoot ? runtimeRoot : dataDir);
      sqlite.markReady();
    } catch (error) {
      sqlite.close({ checkpoint: false });
      throw error;
    }
  }
  return { dataDir, sqlite, store };
}

export async function openOrBootstrapLocalRuntime(
  dataDir = resolveDataDir(),
  dbPath = path.join(path.dirname(dataDir), "attention.db"),
): ReturnType<typeof createLocalRuntime> {
  let repairMirrors = false;
  try {
    const runtime = await createLocalRuntime(dataDir, dbPath, { mode: "fast" });
    if (!runtime.sqlite.status().mirrorRepairRequired) return runtime;
    runtime.sqlite.close({ checkpoint: false });
    repairMirrors = true;
  } catch (error) {
    if (!(error instanceof RuntimeBootstrapRequiredError)) throw error;
    repairMirrors = error.repairMirrors;
  }
  return createLocalRuntime(dataDir, dbPath, { repairMirrors });
}
