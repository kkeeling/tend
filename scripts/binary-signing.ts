import path from "node:path";

export type ReleaseBinaryPaths = {
  tend: string;
  imessageHelper: string;
};

export type CommandRunner = (command: string[]) => Promise<void>;

export const TEND_CODE_SIGNING_IDENTIFIER = "com.every.tend";
export const IMESSAGE_HELPER_CODE_SIGNING_IDENTIFIER = "com.every.tend.imessage-helper";

export function macOSBinarySignatureSpecs(paths: ReleaseBinaryPaths): Array<{
  path: string;
  identifier: string;
}> {
  return [
    { path: paths.tend, identifier: TEND_CODE_SIGNING_IDENTIFIER },
    {
      path: paths.imessageHelper,
      identifier: IMESSAGE_HELPER_CODE_SIGNING_IDENTIFIER,
    },
  ];
}

export async function signAndVerifyReleaseBinaries(
  paths: ReleaseBinaryPaths,
  platform: string = process.platform,
  run: CommandRunner = runCommand,
): Promise<void> {
  if (platform !== "darwin") return;

  const binaries = macOSBinarySignatureSpecs(paths);
  for (const binary of binaries) {
    await signMacOSBinary(binary.path, binary.identifier, platform, run);
  }
  await verifyReleaseBinarySignatures(paths, platform, run);
}

export async function signMacOSBinary(
  binaryPath: string,
  identifier: string,
  platform: string = process.platform,
  run: CommandRunner = runCommand,
): Promise<void> {
  if (platform !== "darwin") return;
  await run([
    "codesign",
    "--force",
    "--sign",
    "-",
    "--identifier",
    identifier,
    binaryPath,
  ]);
}

export async function verifyReleaseBinarySignatures(
  paths: ReleaseBinaryPaths,
  platform: string = process.platform,
  run: CommandRunner = runCommand,
): Promise<void> {
  if (platform !== "darwin") return;

  for (const binary of macOSBinarySignatureSpecs(paths)) {
    await verifyMacOSBinarySignature(binary.path, binary.identifier, platform, run);
  }
}

export async function verifyMacOSBinarySignature(
  binaryPath: string,
  identifier: string,
  platform: string = process.platform,
  run: CommandRunner = runCommand,
): Promise<void> {
  if (platform !== "darwin") return;
  await run([
    "codesign",
    "--verify",
    "--strict",
    "--verbose=2",
    "--test-requirement",
    `=identifier "${identifier}"`,
    binaryPath,
  ]);
}

async function runCommand(command: string[]): Promise<void> {
  const subprocess = Bun.spawn(command, {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (exitCode === 0) return;

  const detail = stderr.trim() || stdout.trim() || "no command output";
  throw new Error(`${command[0]} failed with exit code ${exitCode}: ${detail}`);
}

if (import.meta.main) {
  const root = process.cwd();
  const paths = {
    tend: path.resolve(process.argv[2] ?? path.join(root, "dist-bin", "tend")),
    imessageHelper: path.resolve(
      process.argv[3] ?? path.join(root, "dist-bin", "tend-imessage-helper"),
    ),
  };
  await signAndVerifyReleaseBinaries(paths);
  console.log(JSON.stringify({ ok: true, platform: process.platform, paths }));
}
