import { request, type IncomingMessage } from "node:http";
import path from "node:path";
import { CliError } from "./errors";
import { apiUrl } from "./shared";

interface LiveStatus {
  dataDir?: string;
}

export async function assertCliRuntimeMatchesLive(
  runtimeRoot: string,
  options: {
    explicitRuntime?: boolean;
    fetchStatus?: () => Promise<LiveStatus | null>;
  } = {},
): Promise<void> {
  if (options.explicitRuntime) return;
  const status = await (options.fetchStatus ?? fetchLiveStatus)();
  if (!status?.dataDir) return;

  const liveRuntimeRoot = path.resolve(status.dataDir, "..");
  if (path.resolve(runtimeRoot) === liveRuntimeRoot) return;

  throw new CliError(
    `Tend CLI runtime mismatch: this command resolved ${runtimeRoot}, but the running Tend service uses ${liveRuntimeRoot}.`,
    {
      code: "runtime_mismatch",
      hint: "Run the CLI from the canonical checkout or set ATTENTION_HOME explicitly for isolated validation.",
    },
  );
}

export function fetchLiveStatus(
  url = `${apiUrl()}/api/status`,
  timeoutMs = 500,
): Promise<LiveStatus | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let response: IncomingMessage | null = null;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const failTimeout = () => {
      const error = new CliError(`Tend status did not respond within ${timeoutMs}ms.`, {
        code: "runtime_status_timeout",
        hint: "The local Tend service is accepting connections but is not healthy. Restart or repair it before running agent commands.",
      });
      const fallback = setTimeout(
        () => finish(() => reject(error)),
        Math.max(25, Math.min(100, timeoutMs)),
      );
      probe.once("close", () => {
        clearTimeout(fallback);
        finish(() => reject(error));
      });
      response?.destroy(error);
      const socket = probe.socket;
      if (socket && !socket.destroyed) {
        try {
          socket.resetAndDestroy();
        } catch {
          socket.destroy(error);
        }
      }
      probe.destroy(error);
    };
    const probe = request(url, {
      method: "GET",
      headers: { accept: "application/json" },
      agent: false,
    }, (incoming) => {
      response = incoming;
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 64 * 1024) {
          incoming.destroy(new Error("Tend status response exceeded 64 KiB."));
        }
      });
      incoming.on("end", () => {
        finish(() => {
          if ((incoming.statusCode ?? 500) < 200 || (incoming.statusCode ?? 500) >= 300) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(body) as LiveStatus);
          } catch {
            resolve(null);
          }
        });
      });
      incoming.on("error", (error) => {
        finish(() => reject(error));
      });
    });
    const timer = setTimeout(failTimeout, timeoutMs);
    probe.on("error", (error: NodeJS.ErrnoException) => {
      if (error instanceof CliError) return;
      finish(() => resolve(null));
    });
    probe.end();
  });
}
