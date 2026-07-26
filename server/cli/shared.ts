import { attentionDataDir, attentionDbPath, attentionHome } from "../paths";
import { openOrBootstrapLocalRuntime } from "../runtime";
import { LocalSqliteStore } from "../sqlite";
import { configurePrivateProcessPermissions } from "../util";

export function apiPort(): number {
  return Number(process.env.ATTENTION_API_PORT ?? 4332);
}

export function apiUrl(): string {
  return `http://127.0.0.1:${apiPort()}`;
}

export function print(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

export async function initRuntime(): Promise<LocalSqliteStore> {
  configurePrivateProcessPermissions();
  return (await openOrBootstrapLocalRuntime(attentionDataDir(), attentionDbPath())).sqlite;
}

export function localPaths() {
  return {
    home: attentionHome(),
    dataDir: attentionDataDir(),
    dbPath: attentionDbPath(),
    apiUrl: apiUrl(),
    uiUrl: apiUrl(),
  };
}
