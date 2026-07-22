import path from "node:path";
import {
  signMacOSBinary,
  TEND_CODE_SIGNING_IDENTIFIER,
  verifyMacOSBinarySignature,
  verifyReleaseBinarySignatures,
} from "./binary-signing";
import {
  currentIMessageHelperBuildKey,
  defaultIMessageHelperCacheRoot,
  IMESSAGE_HELPER_BUILD_POLICY,
  prepareIMessageHelperBinary,
} from "./build-imessage-helper";

const root = process.cwd();
const tendPath = path.join(root, "dist-bin", "tend");
const helperPath = path.join(root, "dist-bin", "tend-imessage-helper");

const tendBuild = compile("tend.ts", tendPath);
const helperKey = process.platform === "darwin"
  ? currentIMessageHelperBuildKey(root)
  : undefined;

let helperCache: { reused: boolean; cachePath: string } | undefined;
if (process.platform === "darwin") {
  const key = await helperKey!;
  helperCache = await prepareIMessageHelperBinary({
    output: helperPath,
    cacheRoot: defaultIMessageHelperCacheRoot(),
    key,
    compile: async (destination) => {
      await compile("imessage-helper.ts", destination, IMESSAGE_HELPER_BUILD_POLICY.flags);
      await signMacOSBinary(destination, IMESSAGE_HELPER_BUILD_POLICY.signingIdentifier);
    },
    validate: async (candidate) => {
      await verifyMacOSBinarySignature(candidate, IMESSAGE_HELPER_BUILD_POLICY.signingIdentifier);
    },
  });
} else {
  await compile("imessage-helper.ts", helperPath);
}

await tendBuild;
await signMacOSBinary(tendPath, TEND_CODE_SIGNING_IDENTIFIER);
await verifyReleaseBinarySignatures({ tend: tendPath, imessageHelper: helperPath });

console.log(JSON.stringify({
  ok: true,
  paths: { tend: tendPath, imessageHelper: helperPath },
  ...(helperCache ? { helperCache } : {}),
}, null, 2));

async function compile(
  entrypoint: string,
  output: string,
  flags: readonly string[] = ["--compile"],
): Promise<void> {
  const subprocess = Bun.spawn([
    process.execPath,
    "build",
    path.join(root, entrypoint),
    ...flags,
    "--outfile",
    output,
  ], { stdout: "inherit", stderr: "inherit" });
  const exitCode = await subprocess.exited;
  if (exitCode !== 0) throw new Error(`bun build failed for ${entrypoint} with exit code ${exitCode}`);
}
