#!/usr/bin/env bun
import { collectIMessageReadOnly, IMessageCollectorError } from "./server/sources/imessage";

const [command, ...argv] = process.argv.slice(2);
const value = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

if (command !== "collect") {
  console.error("Usage: tend-imessage-helper collect --since <ISO-8601> [--after-apple-date <decimal> --after-row-id <integer>] [--limit <1-500>]");
  process.exit(2);
}
if (argv.some((argument) => !argument.startsWith("--") && argv[argv.indexOf(argument) - 1]?.startsWith("--") !== true)) {
  console.error("The iMessage helper accepts only collect and its fixed boundary, cursor, and limit options.");
  process.exit(2);
}
const allowedFlags = new Set(["--since", "--after-apple-date", "--after-row-id", "--limit"]);
for (const argument of argv.filter((item) => item.startsWith("--"))) {
  if (!allowedFlags.has(argument)) {
    console.error(`Unsupported iMessage helper option: ${argument}`);
    process.exit(2);
  }
}

try {
  const since = value("since");
  if (!since) throw new Error("The iMessage helper requires --since.");
  const afterAppleDate = value("after-apple-date");
  const afterRowId = value("after-row-id");
  if (Boolean(afterAppleDate) !== Boolean(afterRowId)) throw new Error("Use --after-apple-date and --after-row-id together.");
  const limitValue = value("limit");
  const result = collectIMessageReadOnly({
    since,
    ...(afterAppleDate && afterRowId ? { after: { appleDate: afterAppleDate, rowId: Number(afterRowId) } } : {}),
    ...(limitValue ? { limit: Number(limitValue) } : {}),
  });
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  if (error instanceof IMessageCollectorError) {
    console.error(JSON.stringify({ ok: false, outcome: error.outcome, error: { class: error.errorClass, message: error.message } }));
    process.exit(1);
  }
  console.error(JSON.stringify({ ok: false, outcome: "transient_error", error: { class: "invalid_request", message: error instanceof Error ? error.message : String(error) } }));
  process.exit(2);
}
