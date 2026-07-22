import { randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { digest, ensurePrivateDirectory, withMutationLock } from "../server/util";
import { IMESSAGE_HELPER_CODE_SIGNING_IDENTIFIER } from "./binary-signing";

export const IMESSAGE_HELPER_BUILD_POLICY = {
  command: "bun build",
  flags: ["--compile"],
  signingIdentifier: IMESSAGE_HELPER_CODE_SIGNING_IDENTIFIER,
} as const;

export type IMessageHelperBuildInputs = {
  sources: Array<{ path: string; content: string }>;
  bunVersion: string;
  platform: string;
  arch: string;
  buildPolicy: {
    command: string;
    flags: readonly string[];
    signingIdentifier: string;
  };
};

export type PrepareIMessageHelperOptions = {
  output: string;
  cacheRoot: string;
  key: string;
  compile: (destination: string) => Promise<void>;
  validate: (candidate: string) => Promise<void>;
};

const HELPER_SOURCES = [
  "imessage-helper.ts",
  "server/sources/imessage.ts",
  "tsconfig.json",
] as const;

export function imessageHelperBuildKey(input: IMessageHelperBuildInputs): string {
  const sources = [...input.sources].sort((left, right) => left.path.localeCompare(right.path));
  return digest({
    schema: "tend.imessage-helper-build.v1",
    bunVersion: input.bunVersion,
    platform: input.platform,
    arch: input.arch,
    buildPolicy: input.buildPolicy,
    sources,
  });
}

export async function currentIMessageHelperBuildKey(
  root: string,
  runtime: { bunVersion?: string; platform?: string; arch?: string } = {},
): Promise<string> {
  const sources = await Promise.all(HELPER_SOURCES.map(async (relativePath) => ({
    path: relativePath,
    content: await readFile(path.join(root, relativePath), "utf8"),
  })));
  return imessageHelperBuildKey({
    sources,
    bunVersion: runtime.bunVersion ?? Bun.version,
    platform: runtime.platform ?? process.platform,
    arch: runtime.arch ?? process.arch,
    buildPolicy: IMESSAGE_HELPER_BUILD_POLICY,
  });
}

export function defaultIMessageHelperCacheRoot(): string {
  return path.resolve(path.join(os.homedir(), ".cache", "tend", "imessage-helper"));
}

export async function prepareIMessageHelperBinary(
  options: PrepareIMessageHelperOptions,
): Promise<{ reused: boolean; cachePath: string }> {
  if (!/^[a-f0-9]{64}$/.test(options.key)) {
    throw new Error("The iMessage helper cache key must be a SHA-256 digest.");
  }
  const output = path.resolve(options.output);
  const cacheRoot = path.resolve(options.cacheRoot);
  const cacheDirectory = path.join(cacheRoot, options.key);
  const cachePath = path.join(cacheDirectory, "tend-imessage-helper");
  await mkdir(path.dirname(output), { recursive: true });
  await rejectNonDirectory(cacheRoot);
  await ensurePrivateDirectory(cacheRoot);
  await requirePrivateDirectory(cacheRoot);

  const reused = await withMutationLock(cacheRoot, async () => reuseCachedHelper({
    cacheDirectory,
    cachePath,
    cacheRoot,
    currentKey: options.key,
    output,
    validate: options.validate,
  }));
  if (reused) return { reused: true, cachePath };

  await options.compile(output);
  await chmod(output, 0o700);
  await requireRegularFile(output);
  await options.validate(output);
  return withMutationLock(cacheRoot, async () => {
    const concurrentlyReused = await reuseCachedHelper({
      cacheDirectory,
      cachePath,
      cacheRoot,
      currentKey: options.key,
      output,
      validate: options.validate,
    });
    if (concurrentlyReused) return { reused: true, cachePath };

    await createPrivateCacheDirectory(cacheDirectory);
    const temporaryCachePath = `${cachePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await cp(output, temporaryCachePath);
      await chmod(temporaryCachePath, 0o700);
      await rename(temporaryCachePath, cachePath);
    } finally {
      await rm(temporaryCachePath, { force: true });
    }
    await pruneIMessageHelperCache(cacheRoot, options.key);
    return { reused: false, cachePath };
  });
}

export async function pruneIMessageHelperCache(
  cacheRoot: string,
  currentKey: string,
  retainedEntries = 3,
): Promise<void> {
  const entries = await readdir(cacheRoot, { withFileTypes: true });
  const candidates = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
    .map(async (entry) => ({
      key: entry.name,
      modifiedAt: (await stat(path.join(cacheRoot, entry.name))).mtimeMs,
    })));
  const keep = new Set([
    currentKey,
    ...candidates
      .filter((entry) => entry.key !== currentKey)
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .slice(0, Math.max(0, retainedEntries - 1))
      .map((entry) => entry.key),
  ]);
  await Promise.all(candidates
    .filter((entry) => !keep.has(entry.key))
    .map((entry) => rm(path.join(cacheRoot, entry.key), { recursive: true, force: true })));
}

async function isExistingRegularFile(filename: string): Promise<boolean> {
  try {
    await requireRegularFile(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function reuseCachedHelper(input: {
  cacheDirectory: string;
  cachePath: string;
  cacheRoot: string;
  currentKey: string;
  output: string;
  validate: (candidate: string) => Promise<void>;
}): Promise<boolean> {
  if (!await isExistingRegularFile(input.cachePath)) return false;
  await requirePrivateDirectory(input.cacheDirectory);
  await cp(input.cachePath, input.output);
  await chmod(input.output, 0o700);
  await requireRegularFile(input.output);
  await input.validate(input.output);
  await pruneIMessageHelperCache(input.cacheRoot, input.currentKey);
  return true;
}

async function requireRegularFile(filename: string): Promise<void> {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`The iMessage helper cache entry must be a regular file: ${filename}`);
  }
  requireCurrentOwner(metadata.uid, filename);
  if ((metadata.mode & 0o777) !== 0o700) {
    throw new Error(`The iMessage helper cache entry must use mode 0700: ${filename}`);
  }
}

async function rejectNonDirectory(directory: string): Promise<void> {
  try {
    await requireDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function createPrivateCacheDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await requireDirectory(directory);
  await chmod(directory, 0o700);
  await requirePrivateDirectory(directory);
}

async function requireDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`The iMessage helper cache path must be a real directory: ${directory}`);
  }
  requireCurrentOwner(metadata.uid, directory);
}

async function requirePrivateDirectory(directory: string): Promise<void> {
  await requireDirectory(directory);
  const metadata = await lstat(directory);
  if ((metadata.mode & 0o777) !== 0o700) {
    throw new Error(`The iMessage helper cache directory must use mode 0700: ${directory}`);
  }
}

function requireCurrentOwner(uid: number, filename: string): void {
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && uid !== currentUid) {
    throw new Error(`The iMessage helper cache path must be owned by the current user: ${filename}`);
  }
}
