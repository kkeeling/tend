import { writeFile } from "node:fs/promises";

const [binary, readyPath, stopPath, ...args] = process.argv.slice(2);
if (!binary || !readyPath || !stopPath || args.length === 0) {
  throw new Error("Usage: benchmark-cli-reader <binary> <ready-path> <stop-path> <command...>");
}

let completed = 0;
while (!(await Bun.file(stopPath).exists())) {
  const child = Bun.spawn([binary, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderrPromise = new Response(child.stderr).text();
  const exitCode = await exitWithin(child, 10_000);
  const stderr = await promiseWithin(stderrPromise, 500, "benchmark reader stderr");
  if (exitCode !== 0) throw new Error(stderr || `Benchmark reader exited ${exitCode}.`);
  completed += 1;
  if (completed === 1) await writeFile(readyPath, "ready\n");
}

async function exitWithin(child: ReturnType<typeof Bun.spawn>, timeoutMs: number): Promise<number> {
  const timeout = Symbol("timeout");
  const first = await Promise.race([child.exited, Bun.sleep(timeoutMs).then(() => timeout)]);
  if (typeof first === "number") return first;
  try {
    child.kill("SIGTERM");
  } catch {
    // The child may have exited at the deadline boundary.
  }
  const afterTerm = await Promise.race([child.exited, Bun.sleep(500).then(() => timeout)]);
  if (typeof afterTerm === "number") {
    throw new Error(`Benchmark reader child exceeded its hard ${timeoutMs}ms process deadline.`);
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The child may have exited at the grace boundary.
  }
  await Promise.race([child.exited, Bun.sleep(500)]);
  throw new Error(`Benchmark reader child exceeded its hard ${timeoutMs}ms process deadline.`);
}

async function promiseWithin<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded its hard ${timeoutMs}ms deadline.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
