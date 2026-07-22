import { describe, expect, test } from "bun:test";
import {
  macOSBinarySignatureSpecs,
  signAndVerifyReleaseBinaries,
  verifyReleaseBinarySignatures,
} from "../scripts/binary-signing";

describe("release binary signing", () => {
  const paths = {
    tend: "/tmp/tend",
    imessageHelper: "/tmp/tend-imessage-helper",
  };

  test("assigns stable macOS code-signing identifiers", () => {
    expect(macOSBinarySignatureSpecs(paths)).toEqual([
      { path: paths.tend, identifier: "com.every.tend" },
      {
        path: paths.imessageHelper,
        identifier: "com.every.tend.imessage-helper",
      },
    ]);
  });

  test("ad-hoc signs and then strictly verifies every macOS binary", async () => {
    const commands: string[][] = [];

    await signAndVerifyReleaseBinaries(paths, "darwin", async (command) => {
      commands.push(command);
    });

    expect(commands).toEqual([
      [
        "codesign",
        "--force",
        "--sign",
        "-",
        "--identifier",
        "com.every.tend",
        paths.tend,
      ],
      [
        "codesign",
        "--force",
        "--sign",
        "-",
        "--identifier",
        "com.every.tend.imessage-helper",
        paths.imessageHelper,
      ],
      [
        "codesign",
        "--verify",
        "--strict",
        "--verbose=2",
        "--test-requirement",
        '=identifier "com.every.tend"',
        paths.tend,
      ],
      [
        "codesign",
        "--verify",
        "--strict",
        "--verbose=2",
        "--test-requirement",
        '=identifier "com.every.tend.imessage-helper"',
        paths.imessageHelper,
      ],
    ]);
  });

  test("packaging verification fails closed when codesign fails", async () => {
    await expect(
      verifyReleaseBinarySignatures(paths, "darwin", async () => {
        throw new Error("invalid signature");
      }),
    ).rejects.toThrow("invalid signature");
  });

  test("non-macOS builds do not invoke codesign", async () => {
    let calls = 0;
    await signAndVerifyReleaseBinaries(paths, "linux", async () => {
      calls += 1;
    });
    await verifyReleaseBinarySignatures(paths, "linux", async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });
});
