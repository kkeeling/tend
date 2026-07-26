import { expect, test } from "bun:test";
import { startupResponse } from "../server/routes/startup";

test("startup window preserves the JSON API error contract", async () => {
  const response = startupResponse(new Request("http://127.0.0.1:4332/api/workspace"));

  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("1");
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({ error: "Tend is starting." });
});
