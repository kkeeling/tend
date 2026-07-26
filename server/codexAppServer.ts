import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

declare const Bun: {
  spawn(command: string[], options?: Record<string, unknown>): {
    exited: Promise<number>;
    kill(signal?: number | NodeJS.Signals): void;
    stdin: { write(chunk: string): unknown; flush?: () => unknown; end(): unknown };
    stdout: ReadableStream<Uint8Array> | null;
    stderr: ReadableStream<Uint8Array> | null;
  };
};

export const DEFAULT_CONTROL_SOCKET = path.join(os.homedir(), ".codex", "app-server-control", "app-server-control.sock");
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const DEFAULT_STREAM_DRAIN_GRACE_MS = 500;

export interface AppServerDrainOptions {
  threadId: string;
  prompt: string;
  cwd: string;
  writableRoots?: string[];
  controlSocket?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  log?: (line: string) => void | Promise<void>;
  argv?: string[];
  terminationGraceMs?: number;
  streamDrainGraceMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface StreamPump {
  completed: Promise<void>;
  cancel(): void;
}

export function appServerArgv(controlSocket: string | null | undefined): string[] {
  const socket = controlSocket === null ? null : controlSocket ?? DEFAULT_CONTROL_SOCKET;
  if (socket && existsSync(socket)) return ["codex", "app-server", "proxy", "--sock", socket];
  return ["codex", "app-server"];
}

export async function runAppServerDrain(options: AppServerDrainOptions): Promise<number> {
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? Number(process.env.ATTENTION_DRAIN_TIMEOUT_MS ?? 15 * 60_000);
  const argv = options.argv ?? appServerArgv(options.controlSocket);
  if (options.signal?.aborted) {
    await log("[app-server] drain cancelled before launch");
    return 1;
  }
  await log(`[app-server] launching: ${argv.join(" ")}`);
  if (options.signal?.aborted) {
    await log("[app-server] drain cancelled before launch");
    return 1;
  }

  const child = Bun.spawn(argv, { cwd: options.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let settled = false;
  let exitCode = 1;

  const finish = (code: number, reason: string) => {
    if (settled) return;
    settled = true;
    exitCode = code;
    for (const entry of pending.values()) entry.reject(new Error(reason));
    pending.clear();
    void Promise.resolve(log(`[app-server] ${reason}`)).catch(() => {});
  };

  const send = (message: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.flush?.();
  };

  const request = (method: string, params?: unknown): Promise<unknown> => {
    const id = nextId++;
    const promise = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
    send({ method, id, ...(params === undefined ? {} : { params }) });
    return promise;
  };

  const answerServerRequest = (id: unknown, method: string) => {
    void log(`[app-server] declining server request ${method}`);
    const result = method === "execCommandApproval" || method === "applyPatchApproval"
      ? { decision: "denied" }
      : { decision: "decline" };
    send({ id, result } as Record<string, unknown>);
  };

  const stderrDecoder = new TextDecoder();
  const logStderr = async (text: string) => {
    text = text.trimEnd();
    if (text) await log(`[app-server:err] ${text}`);
  };
  const pipeStderr = startStreamPump(
    child.stderr,
    (chunk) => logStderr(stderrDecoder.decode(chunk, { stream: true })),
    () => logStderr(stderrDecoder.decode()),
  );

  let resolveTurn!: () => void;
  const turnDone = new Promise<void>((resolve) => {
    resolveTurn = resolve;
  });
  let stdoutBuffer = "";
  const handleStdoutLine = async (line: string) => {
    line = line.trim();
    if (!line) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      await log(`[app-server:raw] ${line.slice(0, 400)}`);
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const entry = pending.get(message.id as number);
      if (!entry) return;
      pending.delete(message.id as number);
      if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error).slice(0, 500)));
      else entry.resolve(message.result);
      return;
    }
    if (message.id !== undefined && typeof message.method === "string") {
      answerServerRequest(message.id, message.method);
      return;
    }
    if (message.method === "turn/completed") {
      const params = message.params as { threadId?: string; turn?: { status?: string } } | undefined;
      if (params?.threadId === options.threadId) {
        const status = params.turn?.status ?? "unknown";
        finish(status === "completed" ? 0 : 1, `turn finished with status ${status}`);
        resolveTurn();
      }
    }
  };
  const stdoutDecoder = new TextDecoder();
  const consumeStdout = async (text: string, flush = false) => {
    stdoutBuffer += text;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      await handleStdoutLine(line);
      newline = stdoutBuffer.indexOf("\n");
    }
    if (flush && stdoutBuffer) {
      const finalLine = stdoutBuffer;
      stdoutBuffer = "";
      await handleStdoutLine(finalLine);
    }
  };
  const pipeStdout = startStreamPump(
    child.stdout,
    (chunk) => consumeStdout(stdoutDecoder.decode(chunk, { stream: true })),
    () => consumeStdout(stdoutDecoder.decode(), true),
  );
  void pipeStdout.completed.then(resolveTurn, resolveTurn);
  void child.exited.then((code) => {
    if (!settled) finish(1, `app-server exited with code ${code} before the turn completed`);
    resolveTurn();
  });

  const timeout = setTimeout(() => {
    finish(1, `drain timed out after ${Math.round(timeoutMs / 1000)}s`);
  }, timeoutMs);
  const abort = () => finish(1, "drain cancelled during Tend shutdown");
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();

  try {
    await request("initialize", { clientInfo: { name: "tend_dispatcher", title: "Tend auto-drain", version: "0.1.0" } });
    send({ method: "initialized" });
    await request("thread/resume", {
      threadId: options.threadId,
      cwd: options.cwd,
      approvalPolicy: "never",
      persistExtendedHistory: false,
    });
    await request("turn/start", {
      threadId: options.threadId,
      input: [{ type: "text", text: options.prompt }],
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: options.writableRoots ?? [],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
    await turnDone;
  } catch (error) {
    finish(1, `protocol failure: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    try {
      child.stdin.end();
    } catch {
      // Already closed.
    }
    const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    const streamDrainGraceMs = options.streamDrainGraceMs ?? DEFAULT_STREAM_DRAIN_GRACE_MS;
    await terminateChild(child, terminationGraceMs);
    pipeStdout.cancel();
    pipeStderr.cancel();
    await settleWithin(
      Promise.allSettled([pipeStdout.completed, pipeStderr.completed]).then(() => undefined),
      streamDrainGraceMs,
    );
    if (!settled) finish(1, "app-server exited before the turn completed");
  }
  return exitCode;
}

function startStreamPump(
  stream: ReadableStream<Uint8Array> | null,
  consume: (chunk: Uint8Array) => void | Promise<void>,
  flush?: () => void | Promise<void>,
): StreamPump {
  if (!stream) return { completed: Promise.resolve(), cancel() {} };
  const reader = stream.getReader();
  const completed = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          await flush?.();
          return;
        }
        await consume(value);
      }
    } finally {
      reader.releaseLock();
    }
  })();
  return {
    completed,
    cancel() {
      void reader.cancel().catch(() => {});
    },
  };
}

async function terminateChild(
  child: ReturnType<typeof Bun.spawn>,
  graceMs: number,
): Promise<void> {
  if (await settleWithin(child.exited, 0)) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  if (await settleWithin(child.exited, graceMs)) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
  await settleWithin(child.exited, graceMs);
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
