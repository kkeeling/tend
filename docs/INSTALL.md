# Install

## Requirements

### Packaged Release

- Codex Desktop for the intended in-app-browser and feed-thread workflow
- A Tend archive matching your platform
- Any Codex connectors used by your feeds

The packaged `tend` executable is self-contained and includes the Bun runtime. Bun, Node.js, and
pnpm are not required to run a downloaded release.

### Source And Binary Builds

- Git
- Bun 1.3.11 or newer
- Node.js 22 or newer
- pnpm 9.15.4

```sh
bun --version
node --version
corepack enable
corepack prepare pnpm@9.15.4 --activate
```

## From Source

```sh
pnpm install
pnpm start
```

Open:

```text
http://127.0.0.1:4321
```

Open this URL in Codex Desktop's in-app browser. Tend's intended first-run flow keeps the feed UI
beside the Codex thread that operates it.

The local API listens on:

```text
http://127.0.0.1:4332
```

## Build A Bun Binary

```sh
pnpm build
pnpm tend:build
pnpm tend:smoke
./dist-bin/tend version
./dist-bin/tend start
```

The build produces `tend` plus a separate least-privilege `tend-imessage-helper`. The Tend binary
starts the local app in the background and serves built UI assets and API from
`http://127.0.0.1:4332`.

```sh
./dist-bin/tend health
./dist-bin/tend logs
./dist-bin/tend restart
./dist-bin/tend stop
```

Use `./dist-bin/tend start --foreground` when you want the server attached to the current
terminal.

Package the current platform binary for local distribution:

```sh
pnpm tend:package
```

The package command writes `dist-bin/releases/tend-<version>-<platform>-<arch>.tar.gz` plus a
`.sha256` checksum. The archive contains the `tend` executable, the Tend manual, built `dist/` UI
assets, the dedicated read-only iMessage helper, README, license, contributor notes, all public
install/architecture/agent/data/development/iPhone/security/releasing docs, the changelog, and
operator/capability references, including the personal-fork maintenance policy.
The packaged executable resolves UI assets from the sibling `dist/` directory, so it can be launched
from inside the extracted folder or by absolute path from another working directory.

Release binaries are not Apple Developer ID signed or notarized yet. On macOS, Gatekeeper may show a
first-run warning for downloaded archives. You can still run Tend by opening the binary
explicitly from Finder or by removing the quarantine attribute:

```sh
xattr -d com.apple.quarantine ./tend
./tend start
```

## Optional iMessage/SMS Read Access

The main Tend server never opens `~/Library/Messages/chat.db`. The packaged
`tend-imessage-helper` is the only process that does. It supports one command, a bounded read:

```sh
./tend-imessage-helper collect --since 2026-07-20T00:00:00Z --limit 200
```

On a later pass, provide both fields from the previous `nextWatermark` so messages sharing an exact
timestamp resume after the last processed row:

```sh
./tend-imessage-helper collect --since 2026-07-20T00:00:00Z \
  --after-apple-date 806500800000000000 --after-row-id 12345 --limit 200
```

On macOS, grant Full Disk Access to this helper only when you choose to enable the iMessage source.
Do not grant it to the main Tend server. The helper accepts no database path or SQL argument, opens
only the fixed Messages database read-only, accepts only its own emitted timestamp/row cursor,
caps lookback at 90 days and output at 500 messages,
and has no send/delete command. A denial is recorded as `permission_denied`; it is never treated as
successful coverage.

macOS can attribute a child process's protected-file access to its parent. The packaged
`tend imessage collect` command therefore uses a private temporary `launchd` job whose executable is
the authorized helper itself, then removes that job and its owner-only result files after the first
JSON result, failure, or timeout. This keeps Full Disk Access attached to the helper instead of
expanding access to Codex, a shell, or the main Tend process. Use it instead of invoking the helper
as a Codex child:

```sh
./tend imessage collect --since 2026-07-20T00:00:00Z --limit 200
```

Keep the prior package while validating an upgrade. macOS may retain Full Disk Access on that
versioned helper path. If the new sibling path is denied or remains silent until timeout, Tend can
reuse the prior helper only when its bytes exactly match the current packaged helper. A changed helper
build is never substituted and requires a fresh human grant to the new helper path.

## Codex Setup

Create or choose a feed in Tend, then start one fresh Codex Desktop thread for that feed. Do not
share one thread across multiple feeds.

```sh
pnpm tend -- setup codex --feed <feed-id>
```

Paste the complete output into that feed's thread. It binds the thread, installs or updates one
heartbeat, and asks the thread to handle the feed once immediately.

To run the feed manually later, open or wake that same thread and say:

```text
go deal with the feed
```

Use the manual wake after a paused or missing heartbeat, or whenever you want an immediate sweep.

## Source Coverage Setup

Every required connector source should have a private runtime profile before collection. The
profile names the provider, expected account/tenant/workspace identity, required scope, cadence,
freshness window, and bounded lookback. Verify the active connector profile exactly before binding
or collecting; a connection to the wrong account is an `identity_mismatch`, not coverage.

```sh
tend cli source:profile:set --feed <feed> --source <source> --profile-file <private-json>
tend cli workspace:coverage
```

Successful collection records a completeness proof with observed identity, watermarks,
pagination/truncation, and permission enumeration. Failure paths use `source:attempt:record` and
preserve the last good checkpoint. Keep profile files under private local storage, never in the
repository. `/now` and `/coverage` withhold all-clear until every required profile is fresh.
Healthy no-change attempts preserve the exact prior watermark and explicitly report that no
checkpoint advance occurred.

## Health Check

```sh
pnpm tend -- version
pnpm tend -- start
pnpm tend -- health
pnpm tend -- doctor
pnpm tend -- status
```

`version` prints the app version and CLI contract version. `doctor` checks local storage immediately.
It also calls the running local API at `/api/status`, so run `tend start` first when you want
the full server, version contract, and API readiness check to be green.

## Backup And Restore

```sh
pnpm tend -- backup export ./tend-backup
pnpm tend -- stop
pnpm tend -- backup import ./tend-backup
```

Backups include a consistent SQLite snapshot, the readable `data/` mirrors, and a manifest. Export
requires a destination that does not already exist. Import stages and validates the backup before
swapping data, preserves the previous runtime until the swap succeeds, and refuses to run while the
same Tend home is active. Legacy data-directory-only backups can still be imported.

For a prerelease cutover, retain both the prior package and its compatible backup. Export the new
schema before testing rollback, restore the prior package plus pre-cutover backup together, then
restore the forward archive when returning to the prerelease.

## iPhone Companion

The optional native client additionally requires a Mac, a private Supabase project, Xcode,
XcodeGen, an Apple Account configured in Xcode, and an iOS 17 device or simulator. A paid Apple
Developer Program membership is needed only for TestFlight or App Store distribution. See
[`docs/IOS.md`](./IOS.md) for the complete requirements, magic-link, worker, signing, installation,
and validation guide.
