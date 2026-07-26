import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFile, chmod, link, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const isoNow = () => new Date().toISOString();
export const makeId = (prefix: string) => `${prefix}_${randomUUID()}`;
export const makeToken = () => randomBytes(24).toString("hex");
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive integer.");
  }
  const results = Array.from<R>({ length: values.length });
  let nextIndex = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await transform(values[index] as T, index);
      }
    },
  ));
  return results;
}
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RUNTIME_REPLACEMENT_LOCK_OWNER = "owner.json";
const RUNTIME_REPLACEMENT_LOCK_OWNER_GRACE_MS = 500;

type RuntimeReplacementLockOwner = {
  token: string;
  pid: number;
  acquiredAt: string;
  runtimeRoot: string;
};

export class MissingPrivateDirectoryError extends Error {
  constructor(directory: string) {
    super(`Private Tend state directory does not exist: ${directory}`);
    this.name = "MissingPrivateDirectoryError";
  }
}

export class PrivateDirectoryModeError extends Error {
  constructor(directory: string) {
    super(`Private Tend state directory requires mode 0700: ${directory}`);
    this.name = "PrivateDirectoryModeError";
  }
}

export function configurePrivateProcessPermissions(): void {
  process.umask(0o077);
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Refusing a non-directory or symbolic link inside private Tend state: ${directory}`);
  }
  await chmod(directory, PRIVATE_DIRECTORY_MODE);
}

export async function assertPrivateDirectory(directory: string): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissingPrivateDirectoryError(directory);
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Refusing a non-directory or symbolic link inside private Tend state: ${directory}`);
  }
  if ((metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new PrivateDirectoryModeError(directory);
  }
}

export async function ensurePrivateFile(file: string): Promise<void> {
  try {
    await chmod(file, PRIVATE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function hardenPrivateTree(root: string): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`Refusing a symbolic link inside private Tend state: ${root}`);
  }
  if (metadata.isDirectory()) {
    await chmod(root, PRIVATE_DIRECTORY_MODE);
    for (const entry of await readdir(root)) await hardenPrivateTree(join(root, entry));
    return;
  }
  if (metadata.isFile()) await chmod(root, PRIVATE_FILE_MODE);
}

export async function appendPrivateText(file: string, value: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await appendFile(file, value, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  await ensurePrivateFile(file);
}

export function safeIdentifier(value: string, label: string): string {
  if (!SAFE_IDENTIFIER_PATTERN.test(value) || value === "." || value === "..") {
    throw new Error(`${label} must use only letters, numbers, dots, underscores, and hyphens.`);
  }
  return value;
}

export async function withMutationLock<T>(dataDir: string, callback: () => Promise<T>): Promise<T> {
  await ensurePrivateDirectory(dataDir);
  const lockPath = join(dataDir, ".mutation-lock");
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === 399) throw new Error("Timed out waiting for the filesystem mutation lock.");
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  try {
    return await callback();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

export async function acquireRuntimeReplacementLock(runtimeRoot: string): Promise<() => Promise<void>> {
  const lockPath = `${runtimeRoot}.replacement-lock`;
  const token = makeToken();
  const candidatePath = `${lockPath}.candidate-${token}`;
  await writeFile(
    candidatePath,
    `${JSON.stringify({
      token,
      pid: process.pid,
      acquiredAt: isoNow(),
      runtimeRoot,
    } satisfies RuntimeReplacementLockOwner)}\n`,
    { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" },
  );
  try {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      try {
        // The hard link publishes a fully written owner record as one atomic
        // filesystem operation; contenders can never observe an ownerless lock.
        await link(candidatePath, lockPath);
        await rm(candidatePath, { force: true });
        return () => releaseRuntimeReplacementLock(lockPath, token);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (attempt === 399) throw new Error("Timed out waiting for the runtime replacement lock.");
        if (await reclaimStaleRuntimeReplacementLock(lockPath)) continue;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    }
  } finally {
    await rm(candidatePath, { force: true });
  }
  throw new Error("Timed out waiting for the runtime replacement lock.");
}

export async function withRuntimeReplacementLock<T>(runtimeRoot: string, callback: () => Promise<T>): Promise<T> {
  const release = await acquireRuntimeReplacementLock(runtimeRoot);
  try {
    return await callback();
  } finally {
    await release();
  }
}

async function releaseRuntimeReplacementLock(lockPath: string, token: string): Promise<void> {
  const owner = await readRuntimeReplacementLockOwner(lockPath);
  if (owner?.token !== token) return;
  const releasedPath = `${lockPath}.released-${token}`;
  try {
    await rename(lockPath, releasedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(releasedPath, { recursive: true, force: true });
}

async function reclaimStaleRuntimeReplacementLock(lockPath: string): Promise<boolean> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  const owner = await readRuntimeReplacementLockOwner(lockPath);
  if (owner && processIsAlive(owner.pid)) return false;
  if (!owner && Date.now() - metadata.mtimeMs < RUNTIME_REPLACEMENT_LOCK_OWNER_GRACE_MS) return false;

  const identity = owner?.token ?? `${metadata.dev}-${metadata.ino}`;
  const stalePath = `${lockPath}.stale-${identity}`;
  try {
    await rename(lockPath, stalePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") return false;
    throw error;
  }
}

async function readRuntimeReplacementLockOwner(lockPath: string): Promise<RuntimeReplacementLockOwner | null> {
  try {
    const metadata = await lstat(lockPath);
    const ownerPath = metadata.isDirectory()
      ? join(lockPath, RUNTIME_REPLACEMENT_LOCK_OWNER)
      : lockPath;
    if (!metadata.isDirectory() && (metadata.isSymbolicLink() || !metadata.isFile())) return null;
    const value = JSON.parse(await readFile(ownerPath, "utf8")) as Partial<RuntimeReplacementLockOwner>;
    if (
      typeof value.token !== "string"
      || !value.token
      || typeof value.pid !== "number"
      || !Number.isInteger(value.pid)
      || value.pid <= 0
      || typeof value.acquiredAt !== "string"
      || typeof value.runtimeRoot !== "string"
    ) {
      return null;
    }
    return value as RuntimeReplacementLockOwner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  await rename(temporary, path);
}

export async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value.endsWith("\n") ? value : `${value}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  await rename(temporary, path);
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 56) || "new-feed";
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
