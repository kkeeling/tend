import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectIMessageReadOnly,
  fixedMessagesDatabasePath,
  IMessageCollectorError,
} from "../server/sources/imessage";

const roots: string[] = [];
const APPLE_EPOCH_SECONDS = 978_307_200;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function appleNanoseconds(iso: string): string {
  return ((BigInt(Date.parse(iso)) - BigInt(APPLE_EPOCH_SECONDS) * 1_000n) * 1_000_000n).toString();
}

async function syntheticMessagesDatabase(): Promise<{ root: string; filename: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-imessage-"));
  roots.push(root);
  const filename = path.join(root, "chat.db");
  const database = new Database(filename, { create: true });
  database.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT, service_name TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, date INTEGER, is_from_me INTEGER, service TEXT, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO handle VALUES (1, 'participant-alias', 'iMessage');
    INSERT INTO chat VALUES (1, 'chat-guid-1', 'thread-alias', 'Planning', 'iMessage');
  `);
  database.query("INSERT INTO message VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    1,
    "message-guid-1",
    "I will send the plan tomorrow.",
    appleNanoseconds("2026-07-21T17:00:00.000Z"),
    0,
    "iMessage",
    1,
  );
  database.query("INSERT INTO message VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    2,
    "message-guid-2",
    null,
    appleNanoseconds("2026-07-21T17:05:00.000Z"),
    1,
    "SMS",
    1,
  );
  database.exec("INSERT INTO chat_message_join VALUES (1, 1); INSERT INTO chat_message_join VALUES (1, 2);");
  database.close();
  return { root, filename };
}

async function sha256(filename: string): Promise<string> {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

describe("dedicated read-only iMessage helper", () => {
  test("reads a fixed bounded projection without changing the Messages database", async () => {
    const { filename } = await syntheticMessagesDatabase();
    const before = await sha256(filename);
    const result = collectIMessageReadOnly({ since: "2026-07-21T16:55:00.000Z", limit: 10 }, {
      databasePath: filename,
      hostname: "device-alias",
      now: new Date("2026-07-21T18:00:00.000Z"),
    });
    const after = await sha256(filename);

    expect(after).toBe(before);
    expect(result).toMatchObject({
      schema: "tend.imessage.readonly.v1",
      observedIdentity: { device: "device-alias" },
      truncated: false,
    });
    expect(result.messages).toEqual([
      {
        id: "message-guid-1",
        threadId: "chat-guid-1",
        sentAt: "2026-07-21T17:00:00.000Z",
        direction: "inbound",
        service: "imessage",
        sender: "participant-alias",
        threadName: "Planning",
        text: "I will send the plan tomorrow.",
      },
      {
        id: "message-guid-2",
        threadId: "chat-guid-1",
        sentAt: "2026-07-21T17:05:00.000Z",
        direction: "outbound",
        service: "sms",
        sender: "participant-alias",
        threadName: "Planning",
        textUnavailable: true,
      },
    ]);
    expect(result.nextWatermark).toEqual({ appleDate: appleNanoseconds("2026-07-21T17:05:00.000Z"), rowId: 2 });
    expect(JSON.stringify(result)).not.toContain(filename);
    expect(JSON.stringify(result)).not.toContain("attachment");
  });

  test("preserves nanosecond-scale SQLite timestamps as exact decimal strings", async () => {
    const { filename } = await syntheticMessagesDatabase();
    const database = new Database(filename);
    const exact = "806518800123456789";
    database.query("INSERT INTO message VALUES (?, ?, ?, ?, ?, ?, ?)").run(3, "message-guid-3", "Exact timestamp", exact, 0, "iMessage", 1);
    database.exec("INSERT INTO chat_message_join VALUES (1, 3);");
    database.close();

    const result = collectIMessageReadOnly({ since: "2026-07-21T16:55:00.000Z", limit: 10 }, {
      databasePath: filename,
      now: new Date("2026-07-21T18:00:00.000Z"),
    });
    expect(result.nextWatermark).toEqual({ appleDate: exact, rowId: 3 });
  });

  test("resumes strictly after the exact timestamp and row watermark", async () => {
    const { filename } = await syntheticMessagesDatabase();
    const database = new Database(filename);
    const sharedTimestamp = appleNanoseconds("2026-07-21T17:05:00.000Z");
    database.query("INSERT INTO message VALUES (?, ?, ?, ?, ?, ?, ?)").run(3, "message-guid-3", "Same timestamp, later row", sharedTimestamp, 0, "iMessage", 1);
    database.exec("INSERT INTO chat_message_join VALUES (1, 3);");
    database.close();

    const result = collectIMessageReadOnly({
      since: "2026-07-21T16:55:00.000Z",
      after: { appleDate: sharedTimestamp, rowId: 2 },
      limit: 10,
    }, {
      databasePath: filename,
      now: new Date("2026-07-21T18:00:00.000Z"),
    });

    expect(result.messages.map((message) => message.id)).toEqual(["message-guid-3"]);
    expect(result.scope.after).toEqual({ appleDate: sharedTimestamp, rowId: 2 });
  });

  test("preserves the exact prior watermark on a healthy no-change pass", async () => {
    const { filename } = await syntheticMessagesDatabase();
    const prior = { appleDate: appleNanoseconds("2026-07-21T17:05:00.000Z"), rowId: 2 };
    const result = collectIMessageReadOnly({
      since: "2026-07-21T16:55:00.000Z",
      after: prior,
      limit: 10,
    }, {
      databasePath: filename,
      now: new Date("2026-07-21T18:00:00.000Z"),
    });

    expect(result.messages).toEqual([]);
    expect(result.nextWatermark).toEqual(prior);
    expect(result.truncated).toBe(false);
  });

  test("maps Full Disk Access and schema failures to honest coverage outcomes", async () => {
    expect(() => collectIMessageReadOnly({ since: new Date().toISOString() }, {
      openDatabase: () => { throw new Error("operation not permitted"); },
    })).toThrow(IMessageCollectorError);
    try {
      collectIMessageReadOnly({ since: new Date().toISOString() }, {
        openDatabase: () => { throw new Error("operation not permitted"); },
      });
    } catch (error) {
      expect(error).toMatchObject({ outcome: "permission_denied", errorClass: "full_disk_access_required" });
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "tend-imessage-schema-"));
    roots.push(root);
    const filename = path.join(root, "chat.db");
    const database = new Database(filename, { create: true });
    database.exec("CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, date INTEGER, is_from_me INTEGER, service TEXT, handle_id INTEGER);");
    database.close();
    expect(() => collectIMessageReadOnly({ since: new Date().toISOString() }, { databasePath: filename })).toThrow("schema is missing required table");
  });

  test("exposes no arbitrary database path or outbound command", async () => {
    expect(fixedMessagesDatabasePath("/Users/example")).toBe("/Users/example/Library/Messages/chat.db");
    const helper = path.join(import.meta.dir, "..", "imessage-helper.ts");
    const child = Bun.spawn([process.execPath, helper, "send", "--to", "participant-alias"], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(2);
    const stderr = await new Response(child.stderr).text();
    expect(stderr).toContain("Usage: tend-imessage-helper collect");
    expect(stderr).not.toContain("chat.db");
  });

  test("rejects unbounded lookback and oversized result requests before opening the database", () => {
    let opened = false;
    const openDatabase = () => {
      opened = true;
      throw new Error("should not open");
    };
    expect(() => collectIMessageReadOnly({ since: "2026-01-01T00:00:00.000Z" }, {
      now: new Date("2026-07-21T18:00:00.000Z"),
      openDatabase,
    })).toThrow("cannot exceed 90 days");
    expect(() => collectIMessageReadOnly({ since: "2026-07-21T17:00:00.000Z", limit: 501 }, {
      now: new Date("2026-07-21T18:00:00.000Z"),
      openDatabase,
    })).toThrow("between 1 and 500");
    expect(() => collectIMessageReadOnly({
      since: "2026-07-21T17:00:00.000Z",
      after: { appleDate: appleNanoseconds("2026-07-21T16:59:00.000Z"), rowId: 1 },
    }, {
      now: new Date("2026-07-21T18:00:00.000Z"),
      openDatabase,
    })).toThrow("cannot precede");
    expect(opened).toBe(false);
  });
});
