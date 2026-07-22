import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { print } from "./shared";

const MAX_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_MESSAGES = 500;

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

class IMessageHelperTimeoutError extends Error {
  constructor() {
    super("The Messages helper did not return a complete JSON result before the timeout.");
    this.name = "IMessageHelperTimeoutError";
  }
}

export type IMessageLaunchdDependencies = {
  platform?: string;
  helperPath?: string;
  helperPaths?: string[];
  temporaryRoot?: string;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  run?: (command: string[]) => Promise<CommandResult>;
};

export async function imessageCollectCommand(
  args: string[],
  dependencies: IMessageLaunchdDependencies = {},
): Promise<void> {
  const result = await collectIMessageViaLaunchd(args, dependencies);
  print(result);
  if (result.ok !== true) process.exitCode = 1;
}

export async function collectIMessageViaLaunchd(
  args: string[],
  dependencies: IMessageLaunchdDependencies = {},
): Promise<Record<string, unknown>> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error("The Tend Messages collector is available only on macOS.");
  }

  const packagedHelperPath = dependencies.helperPath ?? resolvePackagedHelperPath();
  if (!existsSync(packagedHelperPath)) {
    throw new Error("The packaged tend-imessage-helper is missing beside the Tend binary.");
  }
  const helperPaths = dependencies.helperPaths
    ?? (dependencies.helperPath ? [packagedHelperPath] : await resolvePackagedHelperPaths(packagedHelperPath));
  const now = dependencies.now ?? Date.now;
  const helperArguments = normalizeCollectArguments(args, new Date(now()));
  const temporaryRoot = dependencies.temporaryRoot ?? os.tmpdir();
  const run = dependencies.run ?? runCommand;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  const timeoutMs = dependencies.timeoutMs ?? 30_000;

  for (let index = 0; index < helperPaths.length; index += 1) {
    let result: Record<string, unknown>;
    try {
      result = await collectWithHelper({
        helperPath: helperPaths[index]!,
        helperArguments,
        temporaryRoot,
        timeoutMs,
        now,
        sleep,
        run,
      });
    } catch (error) {
      if (!(error instanceof IMessageHelperTimeoutError) || index === helperPaths.length - 1) throw error;
      continue;
    }
    if (result.outcome !== "permission_denied" || index === helperPaths.length - 1) return result;
  }
  throw new Error("No packaged Messages helper candidate returned a result.");
}

async function collectWithHelper(options: {
  helperPath: string;
  helperArguments: string[];
  temporaryRoot: string;
  timeoutMs: number;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  run: (command: string[]) => Promise<CommandResult>;
}): Promise<Record<string, unknown>> {
  const { helperPath, helperArguments, temporaryRoot, timeoutMs, now, sleep, run } = options;
  const temporaryDirectory = await mkdtemp(path.join(temporaryRoot, "tend-imessage-collect-"));
  const stdoutPath = path.join(temporaryDirectory, "result.json");
  const stderrPath = path.join(temporaryDirectory, "error.json");
  const label = `com.every.tend.imessage-collect.${process.pid}.${randomUUID()}`;
  await chmod(temporaryDirectory, 0o700);
  await Promise.all([
    writeFile(stdoutPath, "", { flag: "wx", mode: 0o600 }),
    writeFile(stderrPath, "", { flag: "wx", mode: 0o600 }),
  ]);

  try {
    const submission = await run([
      "launchctl",
      "submit",
      "-l",
      label,
      "-p",
      helperPath,
      "-o",
      stdoutPath,
      "-e",
      stderrPath,
      "--",
      helperPath,
      ...helperArguments,
    ]);
    if (submission.exitCode !== 0) {
      throw new Error(`launchctl could not start the Messages helper (exit ${submission.exitCode}).`);
    }

    const deadline = now() + timeoutMs;
    while (now() <= deadline) {
      const result = await firstCompleteResult(stdoutPath, stderrPath);
      if (result) return result;
      await sleep(25);
    }
    throw new IMessageHelperTimeoutError();
  } finally {
    try {
      await removeLaunchdJob(run, label);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

export function normalizeCollectArguments(args: string[], now = new Date()): string[] {
  const [command, ...argv] = args;
  if (command !== "collect") throw new Error(imessageUsage());

  const allowed = new Set(["--since", "--after-apple-date", "--after-row-id", "--limit"]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !allowed.has(flag) || !value || value.startsWith("--")) {
      throw new Error(imessageUsage());
    }
    if (values.has(flag)) throw new Error(`Duplicate Messages collector option: ${flag}.`);
    values.set(flag, value);
  }

  const sinceValue = values.get("--since");
  if (!sinceValue) throw new Error("The Messages collector requires --since.");
  const since = new Date(sinceValue);
  if (Number.isNaN(since.getTime())) throw new Error("The Messages collector requires a valid ISO --since boundary.");
  if (since.getTime() > now.getTime() + 5 * 60_000) throw new Error("The Messages --since boundary cannot be in the future.");
  if (now.getTime() - since.getTime() > MAX_LOOKBACK_MS) throw new Error("The Messages collection lookback cannot exceed 90 days.");

  const limitValue = values.get("--limit");
  const limit = limitValue === undefined ? undefined : Number(limitValue);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_MESSAGES)) {
    throw new Error(`The Messages collection limit must be between 1 and ${MAX_MESSAGES}.`);
  }

  const afterAppleDate = values.get("--after-apple-date");
  const afterRowId = values.get("--after-row-id");
  if (Boolean(afterAppleDate) !== Boolean(afterRowId)) {
    throw new Error("Use --after-apple-date and --after-row-id together.");
  }
  if (afterAppleDate && !/^\d+$/.test(afterAppleDate)) {
    throw new Error("The Messages resume watermark requires a decimal Apple timestamp.");
  }
  if (afterRowId && (!Number.isSafeInteger(Number(afterRowId)) || Number(afterRowId) < 1)) {
    throw new Error("The Messages resume watermark requires a positive safe row id.");
  }

  return [
    "collect",
    "--since",
    since.toISOString(),
    ...(afterAppleDate && afterRowId
      ? ["--after-apple-date", afterAppleDate, "--after-row-id", afterRowId]
      : []),
    ...(limit === undefined ? [] : ["--limit", String(limit)]),
  ];
}

function resolvePackagedHelperPath(): string {
  for (const candidate of [process.argv[0], process.execPath]) {
    if (!candidate || candidate.startsWith("/$bunfs/") || !existsSync(candidate)) continue;
    const helperPath = path.join(path.dirname(path.resolve(candidate)), "tend-imessage-helper");
    if (existsSync(helperPath)) return helperPath;
  }
  return path.join(path.dirname(path.resolve(process.execPath)), "tend-imessage-helper");
}

async function resolvePackagedHelperPaths(packagedHelperPath: string): Promise<string[]> {
  const packageDirectory = path.dirname(packagedHelperPath);
  const installRoot = path.dirname(packageDirectory);
  const suffix = `-${process.platform}-${process.arch}`;
  let entries;
  try {
    entries = await readdir(installRoot, { withFileTypes: true });
  } catch {
    return [packagedHelperPath];
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("tend-") && entry.name.endsWith(suffix))
    .map((entry) => path.join(installRoot, entry.name, "tend-imessage-helper"))
    .sort((left, right) => right.localeCompare(left));
  return identicalHelperCandidates(packagedHelperPath, [packagedHelperPath, ...candidates]);
}

export async function identicalHelperCandidates(packagedHelperPath: string, candidates: string[]): Promise<string[]> {
  const packagedDigest = await fileDigest(packagedHelperPath);
  const matching: string[] = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (matching.includes(resolved) || !existsSync(resolved)) continue;
    if (await fileDigest(resolved) === packagedDigest) matching.push(resolved);
  }
  return matching;
}

async function fileDigest(filename: string): Promise<string> {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

async function firstCompleteResult(
  stdoutPath: string,
  stderrPath: string,
): Promise<Record<string, unknown> | undefined> {
  for (const filename of [stdoutPath, stderrPath]) {
    const content = await readFile(filename, "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const result = JSON.parse(line) as unknown;
        if (result && typeof result === "object" && typeof (result as { ok?: unknown }).ok === "boolean") {
          return result as Record<string, unknown>;
        }
      } catch {
        // A partial line can be observed while launchd is still flushing the helper output.
      }
    }
  }
  return undefined;
}

async function runCommand(command: string[]): Promise<CommandResult> {
  const subprocess = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function removeLaunchdJob(
  run: (command: string[]) => Promise<CommandResult>,
  label: string,
): Promise<void> {
  const removal = await run(["launchctl", "remove", label]).catch(() => undefined);
  if (removal?.exitCode === 0) return;
  const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/unknown";
  const inspection = await run(["launchctl", "print", `${domain}/${label}`]).catch(() => undefined);
  if (!inspection || inspection.exitCode !== 0) return;
  throw new Error("Tend could not remove the temporary Messages launchd job.");
}

function imessageUsage(): string {
  return "Usage: tend imessage collect --since <ISO-8601> [--after-apple-date <decimal> --after-row-id <integer>] [--limit <1-500>]";
}
