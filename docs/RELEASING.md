# Releasing

Tend releases are tagged local-first snapshots. They make builds reproducible and bug reports
specific; they do not imply a hosted service, auto-update channel, or support SLA.

## Versioning

- `package.json` is the source of truth for the app version.
- Use SemVer.
- Before `1.0.0`, minor releases may contain breaking changes, but release notes must call them out.
- Patch releases should be bug fixes only.
- Prereleases use normal SemVer labels, for example `0.2.0-beta.1`.

## Compatibility Versions

The app version, SQLite schema version, and CLI contract version are separate.

- App version: user-visible release snapshot.
- SQLite schema version: local database shape. Forward-only migrations are expected.
- CLI contract version: agent-facing command compatibility.

`tend version`, `tend status`, `tend doctor`, and `/api/status` report the app version
and CLI contract version. `tend doctor` also reports the SQLite schema version.

Compatibility rules:

- Do not remove CLI commands casually.
- Prefer additive CLI changes.
- Document breaking CLI or schema changes in `CHANGELOG.md`.
- Refuse to open data from a newer schema version once that guard exists.
- Take or instruct a backup before destructive migrations.

## Release Checklist

1. Update `package.json` version.
2. Update `CHANGELOG.md`.
3. Run:

   ```sh
   pnpm install --frozen-lockfile
   pnpm check
   pnpm audit --prod
   pnpm build
   pnpm tend:build
   pnpm tend:smoke
   pnpm bench:runtime
   pnpm tend:package
   ```

4. Confirm `tend version` reports the new version.
5. Commit the version and changelog changes.
6. Tag and push:

   ```sh
   git tag v0.1.1
   git push origin main --tags
   ```

7. Review the draft GitHub Release, attached archives, and checksums.
8. Publish the release when the artifacts look correct.

Personal fork prereleases use a fork-specific SemVer identifier such as
`0.3.0-keeling.1`. Promote and tag them from the deployable `life-control-plane` branch, not the
upstream-aligned `main`, after testing a restored copy of the live runtime. Keep the prior
package/data pair, export the migrated runtime before a rollback rehearsal, and restore compatible
binary/data pairs together. See
`docs/PERSONAL_FORK.md` for deliberate upstream intake and contribution extraction.

Before a personal live cutover, export an owner-only backup outside synchronized folders and verify
its manifest. Record the composite source revision plus archive and executable SHA-256 digests,
install that exact archive, and verify `version`, `health`, schema/readiness, packaged smoke, and
runtime benchmark results from the installed binary. If a versioned executable path changes, update
every Tend automation only after the installed health check passes, then verify each definition
still names its exact feed and home task. Retain the previous binary with its pre-migration backup
as one rollback pair.

## Artifacts

Release archives are named:

```text
tend-<version>-<platform>-<arch>.tar.gz
tend-<version>-<platform>-<arch>.tar.gz.sha256
```

Each archive contains:

- `tend` executable
- `tend-imessage-helper` least-privilege read-only executable
- bundled `dist/` UI assets
- `README.md`
- `MANUAL.md`
- `CONTRIBUTING.md`
- `LICENSE`
- install, agent, data, security, and releasing docs
- personal-fork maintenance policy
- runbook and capability map
- `manifest.json`

On macOS, `pnpm tend:build` replaces Bun's linker signature with valid ad-hoc signatures using
stable identifiers for both executables. `pnpm tend:package` verifies both signatures and fails
closed before creating an archive if either binary was modified after signing. Ad-hoc signing does
not establish a trusted developer identity. The build keeps a mode-`0700`, content-keyed helper cache
under the fixed `~/.cache/tend/imessage-helper` path; the key covers the exact helper sources, Bun
version, platform, architecture, TypeScript build configuration, compiler mode, and signing
identity. The path has no environment override. When those inputs are unchanged, the next local
prerelease reuses and re-verifies the same signed helper bytes. After a path-specific denial or
silent timeout, Tend can therefore
reuse an already-authorized prior package path only when that helper is byte-identical to the current
packaged helper. Changed helper source or build-runtime inputs deliberately produce a new cache key
and may require Full Disk Access to be granted again.

## Automation

The release workflow runs on `v*` tags. It builds native binaries on the configured GitHub-hosted
runners, runs the binary smoke test, packages each archive, uploads artifacts, and creates a draft
GitHub Release with generated notes.
