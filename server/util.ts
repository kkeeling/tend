import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFile, chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const isoNow = () => new Date().toISOString();
export const makeId = (prefix: string) => `${prefix}_${randomUUID()}`;
export const makeToken = () => randomBytes(24).toString("hex");
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function configurePrivateProcessPermissions(): void {
  process.umask(0o077);
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(directory, PRIVATE_DIRECTORY_MODE);
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
