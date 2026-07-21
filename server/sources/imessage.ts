import { Database } from "bun:sqlite";
import os from "node:os";
import path from "node:path";
import type { SourceAttemptOutcome, SourceIdentity } from "../../shared/types";

const APPLE_EPOCH_SECONDS = 978_307_200;
const MAX_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_MESSAGES = 500;
const MAX_TEXT_LENGTH = 4_000;
const REQUIRED_TABLES = ["message", "handle", "chat", "chat_message_join"] as const;

const MESSAGE_QUERY = `
  SELECT
    m.ROWID AS row_id,
    m.guid AS message_guid,
    m.text AS message_text,
    m.date AS apple_date,
    m.is_from_me AS is_from_me,
    m.service AS message_service,
    h.id AS sender_handle,
    c.guid AS chat_guid,
    c.chat_identifier AS chat_identifier,
    c.display_name AS chat_name,
    c.service_name AS chat_service
  FROM message AS m
  LEFT JOIN handle AS h ON h.ROWID = m.handle_id
  LEFT JOIN chat_message_join AS cmj ON cmj.message_id = m.ROWID
  LEFT JOIN chat AS c ON c.ROWID = cmj.chat_id
  WHERE m.date >= ?
  ORDER BY m.date ASC, m.ROWID ASC
  LIMIT ?
`;

interface IMessageRow {
  row_id: number;
  message_guid: string | null;
  message_text: string | null;
  apple_date: number;
  is_from_me: number;
  message_service: string | null;
  sender_handle: string | null;
  chat_guid: string | null;
  chat_identifier: string | null;
  chat_name: string | null;
  chat_service: string | null;
}

interface ReadonlyMessagesDatabase {
  query(sql: string): {
    all(...parameters: unknown[]): unknown[];
  };
  exec(sql: string): unknown;
  close(): void;
}

export interface IMessageCollectorDependencies {
  databasePath?: string;
  hostname?: string;
  now?: Date;
  openDatabase?: (databasePath: string) => ReadonlyMessagesDatabase;
}

export interface IMessageCollection {
  schema: "tend.imessage.readonly.v1";
  collectedAt: string;
  observedIdentity: SourceIdentity;
  scope: { since: string; limit: number };
  messages: Array<{
    id: string;
    threadId: string;
    sentAt: string;
    direction: "inbound" | "outbound";
    service: string;
    sender?: string;
    threadName?: string;
    text?: string;
    textUnavailable?: true;
  }>;
  nextWatermark: { appleDate: number; rowId: number } | null;
  truncated: boolean;
}

export class IMessageCollectorError extends Error {
  constructor(
    readonly outcome: Extract<SourceAttemptOutcome, "permission_denied" | "connector_unavailable" | "transient_error" | "partial">,
    readonly errorClass: string,
    message: string,
  ) {
    super(message);
    this.name = "IMessageCollectorError";
  }
}

export function fixedMessagesDatabasePath(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, "Library", "Messages", "chat.db");
}

export function collectIMessageReadOnly(
  input: { since: string; limit?: number },
  dependencies: IMessageCollectorDependencies = {},
): IMessageCollection {
  const now = dependencies.now ?? new Date();
  const since = new Date(input.since);
  if (Number.isNaN(since.getTime())) throw new Error("iMessage collection requires a valid ISO --since boundary.");
  if (since.getTime() > now.getTime() + 5 * 60_000) throw new Error("iMessage --since boundary cannot be in the future.");
  if (now.getTime() - since.getTime() > MAX_LOOKBACK_MS) throw new Error("iMessage collection lookback cannot exceed 90 days.");
  const limit = input.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MESSAGES) throw new Error(`iMessage collection limit must be between 1 and ${MAX_MESSAGES}.`);

  const databasePath = dependencies.databasePath ?? fixedMessagesDatabasePath();
  const openDatabase = dependencies.openDatabase ?? ((filename: string) => new Database(filename, { readonly: true, strict: true }));
  let database: ReadonlyMessagesDatabase | undefined;
  try {
    database = openDatabase(databasePath);
    database.exec("PRAGMA query_only = ON;");
    assertMessagesSchema(database);
    const rows = database.query(MESSAGE_QUERY).all(toAppleNanoseconds(since), limit + 1) as IMessageRow[];
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      schema: "tend.imessage.readonly.v1",
      collectedAt: now.toISOString(),
      observedIdentity: { device: (dependencies.hostname ?? os.hostname()).trim().toLowerCase() },
      scope: { since: since.toISOString(), limit },
      messages: visible.map(minimizeMessage),
      nextWatermark: last ? { appleDate: last.apple_date, rowId: last.row_id } : null,
      truncated: rows.length > limit,
    };
  } catch (error) {
    if (error instanceof IMessageCollectorError) throw error;
    throw classifyCollectorError(error);
  } finally {
    database?.close();
  }
}

function assertMessagesSchema(database: ReadonlyMessagesDatabase): void {
  const rows = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?)")
    .all(...REQUIRED_TABLES) as Array<{ name: string }>;
  const found = new Set(rows.map((row) => row.name));
  const missing = REQUIRED_TABLES.filter((table) => !found.has(table));
  if (missing.length) {
    throw new IMessageCollectorError("partial", "schema_mismatch", `Messages database schema is missing required table(s): ${missing.join(", ")}.`);
  }
}

function minimizeMessage(row: IMessageRow): IMessageCollection["messages"][number] {
  const text = row.message_text?.trim().slice(0, MAX_TEXT_LENGTH);
  return {
    id: row.message_guid?.trim() || `row-${row.row_id}`,
    threadId: row.chat_guid?.trim() || row.chat_identifier?.trim() || row.sender_handle?.trim() || `unknown-${row.row_id}`,
    sentAt: fromAppleTimestamp(row.apple_date).toISOString(),
    direction: row.is_from_me ? "outbound" : "inbound",
    service: (row.message_service || row.chat_service || "unknown").toLowerCase(),
    ...(row.sender_handle?.trim() ? { sender: row.sender_handle.trim() } : {}),
    ...(row.chat_name?.trim() ? { threadName: row.chat_name.trim() } : {}),
    ...(text ? { text } : { textUnavailable: true as const }),
  };
}

function toAppleNanoseconds(date: Date): number {
  return Math.round((date.getTime() / 1_000 - APPLE_EPOCH_SECONDS) * 1_000_000_000);
}

function fromAppleTimestamp(value: number): Date {
  const seconds = Math.abs(value) > 1_000_000_000_000 ? value / 1_000_000_000 : value;
  return new Date((seconds + APPLE_EPOCH_SECONDS) * 1_000);
}

function classifyCollectorError(error: unknown): IMessageCollectorError {
  const message = error instanceof Error ? error.message : String(error);
  if (/not authorized|authorization denied|operation not permitted|permission denied/i.test(message)) {
    return new IMessageCollectorError("permission_denied", "full_disk_access_required", "Messages access was denied. Grant Full Disk Access to the dedicated Tend iMessage helper, then retry.");
  }
  if (/unable to open|no such file|cannot open/i.test(message)) {
    return new IMessageCollectorError("connector_unavailable", "messages_database_unavailable", "The fixed Messages database is unavailable on this Mac.");
  }
  return new IMessageCollectorError("transient_error", "messages_query_failed", `The read-only Messages query failed: ${message}`);
}
