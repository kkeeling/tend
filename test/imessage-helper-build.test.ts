import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  defaultIMessageHelperCacheRoot,
  currentIMessageHelperBuildKey,
  imessageHelperBuildKey,
  IMESSAGE_HELPER_BUILD_POLICY,
  prepareIMessageHelperBinary,
  pruneIMessageHelperCache,
} from "../scripts/build-imessage-helper";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; output: string; cacheRoot: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-imessage-build-test-"));
  roots.push(root);
  return {
    root,
    output: path.join(root, "dist", "tend-imessage-helper"),
    cacheRoot: path.join(root, "cache"),
  };
}

describe("stable iMessage helper builds", () => {
  test("keys the helper artifact to exact source and build-runtime inputs", () => {
    const base = {
      sources: [
        { path: "imessage-helper.ts", content: "entry" },
        { path: "server/sources/imessage.ts", content: "collector" },
      ],
      bunVersion: "1.3.1",
      platform: "darwin",
      arch: "arm64",
      buildPolicy: IMESSAGE_HELPER_BUILD_POLICY,
    };

    expect(imessageHelperBuildKey(base)).toBe(imessageHelperBuildKey({
      ...base,
      sources: [...base.sources].reverse(),
    }));
    expect(imessageHelperBuildKey(base)).not.toBe(imessageHelperBuildKey({
      ...base,
      sources: [{ path: "imessage-helper.ts", content: "changed" }, base.sources[1]!],
    }));
    expect(imessageHelperBuildKey(base)).not.toBe(imessageHelperBuildKey({
      ...base,
      bunVersion: "1.3.2",
    }));
    expect(imessageHelperBuildKey(base)).not.toBe(imessageHelperBuildKey({
      ...base,
      platform: "linux",
    }));
    expect(imessageHelperBuildKey(base)).not.toBe(imessageHelperBuildKey({
      ...base,
      arch: "x64",
    }));
    expect(imessageHelperBuildKey(base)).not.toBe(imessageHelperBuildKey({
      ...base,
      buildPolicy: { ...base.buildPolicy, flags: ["--compile", "--minify"] },
    }));
  });

  test("keeps the cache at the fixed owner-local path", () => {
    const previous = process.env.TEND_IMESSAGE_HELPER_CACHE_DIR;
    process.env.TEND_IMESSAGE_HELPER_CACHE_DIR = "/tmp/redirected-tend-cache";
    try {
      expect(defaultIMessageHelperCacheRoot()).toBe(path.join(os.homedir(), ".cache", "tend", "imessage-helper"));
    } finally {
      if (previous === undefined) delete process.env.TEND_IMESSAGE_HELPER_CACHE_DIR;
      else process.env.TEND_IMESSAGE_HELPER_CACHE_DIR = previous;
    }
  });

  test("includes TypeScript build configuration in the current key", async () => {
    const { root } = await fixture();
    await mkdir(path.join(root, "server", "sources"), { recursive: true });
    await writeFile(path.join(root, "imessage-helper.ts"), "entry");
    await writeFile(path.join(root, "server", "sources", "imessage.ts"), "collector");
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022" } }));
    const before = await currentIMessageHelperBuildKey(root, {
      bunVersion: "1.3.1",
      platform: "darwin",
      arch: "arm64",
    });

    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2021" } }));

    expect(await currentIMessageHelperBuildKey(root, {
      bunVersion: "1.3.1",
      platform: "darwin",
      arch: "arm64",
    })).not.toBe(before);
  });

  test("reuses byte-identical cached helper output without recompiling", async () => {
    const { output, cacheRoot } = await fixture();
    const key = "a".repeat(64);
    const cached = path.join(cacheRoot, key, "tend-imessage-helper");
    await mkdir(path.dirname(cached), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(cached), 0o700);
    await writeFile(cached, "approved-helper", { mode: 0o700 });
    let compileCalls = 0;

    const result = await prepareIMessageHelperBinary({
      output,
      cacheRoot,
      key,
      compile: async () => { compileCalls += 1; },
      validate: async (candidate) => {
        expect(candidate).toBe(output);
      },
    });

    expect(result).toEqual({ reused: true, cachePath: cached });
    expect(compileCalls).toBe(0);
    expect(await readFile(output, "utf8")).toBe("approved-helper");
    expect((await stat(output)).mode & 0o777).toBe(0o700);
  });

  test("compiles, validates, and caches one canonical helper on a miss", async () => {
    const { output, cacheRoot } = await fixture();
    const key = "b".repeat(64);
    const cached = path.join(cacheRoot, key, "tend-imessage-helper");
    const calls: string[] = [];

    const result = await prepareIMessageHelperBinary({
      output,
      cacheRoot,
      key,
      compile: async (destination) => {
        calls.push("compile");
        await writeFile(destination, "new-helper", { mode: 0o700 });
      },
      validate: async (candidate) => {
        calls.push("validate");
        expect(candidate).toBe(output);
      },
    });

    expect(result).toEqual({ reused: false, cachePath: cached });
    expect(calls).toEqual(["compile", "validate"]);
    expect(await readFile(cached, "utf8")).toBe("new-helper");
    expect((await stat(cached)).mode & 0o777).toBe(0o700);
  });

  test("rejects a cached helper that fails signature validation", async () => {
    const { output, cacheRoot } = await fixture();
    const key = "c".repeat(64);
    const cached = path.join(cacheRoot, key, "tend-imessage-helper");
    await mkdir(path.dirname(cached), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(cached), 0o700);
    await writeFile(cached, "tampered", { mode: 0o700 });

    await expect(prepareIMessageHelperBinary({
      output,
      cacheRoot,
      key,
      compile: async () => { throw new Error("must not compile over an invalid cache entry"); },
      validate: async () => { throw new Error("invalid signature"); },
    })).rejects.toThrow("invalid signature");
  });

  test("rejects directory and symbolic-link cache entries", async () => {
    for (const [index, entryType] of ["directory", "symlink"].entries()) {
      const { output, cacheRoot, root } = await fixture();
      const key = String(index + 4).repeat(64);
      const cached = path.join(cacheRoot, key, "tend-imessage-helper");
      await mkdir(path.dirname(cached), { recursive: true, mode: 0o700 });
      await chmod(path.dirname(cached), 0o700);
      if (entryType === "directory") {
        await mkdir(cached);
      } else {
        const target = path.join(root, "target-helper");
        await writeFile(target, "untrusted-helper");
        await symlink(target, cached);
      }
      let callbackCalls = 0;

      await expect(prepareIMessageHelperBinary({
        output,
        cacheRoot,
        key,
        compile: async () => { callbackCalls += 1; },
        validate: async () => { callbackCalls += 1; },
      })).rejects.toThrow("must be a regular file");
      expect(callbackCalls).toBe(0);
    }
  });

  test("rejects an overly permissive cached helper", async () => {
    const { output, cacheRoot } = await fixture();
    const key = "6".repeat(64);
    const cached = path.join(cacheRoot, key, "tend-imessage-helper");
    await mkdir(path.dirname(cached), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(cached), 0o700);
    await writeFile(cached, "untrusted-helper", { mode: 0o777 });
    await chmod(cached, 0o777);

    await expect(prepareIMessageHelperBinary({
      output,
      cacheRoot,
      key,
      compile: async () => { throw new Error("must not compile"); },
      validate: async () => { throw new Error("must not validate"); },
    })).rejects.toThrow("must use mode 0700");
  });

  test("serializes concurrent publication and reuses one canonical helper", async () => {
    const { root, cacheRoot } = await fixture();
    const key = "e".repeat(64);
    let releaseCompiles!: () => void;
    const compileGate = new Promise<void>((resolve) => { releaseCompiles = resolve; });
    let compileCalls = 0;
    const prepare = (name: string) => prepareIMessageHelperBinary({
      output: path.join(root, name, "tend-imessage-helper"),
      cacheRoot,
      key,
      compile: async (destination) => {
        compileCalls += 1;
        await compileGate;
        await writeFile(destination, `helper-${name}`, { mode: 0o700 });
      },
      validate: async () => {},
    });

    const first = prepare("first");
    const second = prepare("second");
    while (compileCalls < 2) await Bun.sleep(1);
    releaseCompiles();
    const results = await Promise.all([first, second]);
    const cached = path.join(cacheRoot, key, "tend-imessage-helper");

    expect(results.map((result) => result.reused).sort()).toEqual([false, true]);
    expect(await readFile(path.join(root, "first", "tend-imessage-helper"), "utf8"))
      .toBe(await readFile(cached, "utf8"));
    expect(await readFile(path.join(root, "second", "tend-imessage-helper"), "utf8"))
      .toBe(await readFile(cached, "utf8"));
  });

  test("retains the current helper plus only the newest bounded cache entries", async () => {
    const { cacheRoot } = await fixture();
    const keys = ["a", "b", "c", "d"].map((value) => value.repeat(64));
    for (const [index, key] of keys.entries()) {
      const directory = path.join(cacheRoot, key);
      await mkdir(directory, { recursive: true });
      await utimes(directory, index + 1, index + 1);
    }

    await pruneIMessageHelperCache(cacheRoot, keys[0]!, 3);

    expect((await readdir(cacheRoot)).sort()).toEqual([keys[0], keys[2], keys[3]].sort());
  });
});
