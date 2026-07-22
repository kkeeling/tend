# Changelog

Tend uses SemVer for tagged release snapshots. Releases are provided for reproducibility, not as
a promise of ongoing maintenance.

## Unreleased

- Separate local card dismissal from source cleanup. `tend cli card:dismiss` now moves a reviewable
  card to `done` with no work item, approval digest, `action:verify`, or connector call, and is
  reversible with `card:return-to-review`. Explicit source cleanup moves to
  `card:cleanup-source`, with `card:undo-cleanup-source` available before Codex starts it.
- Make local dismissal the default injected card control in the browser and iPhone apps; the
  connector `Archive` control now appears only when a card explicitly configures source cleanup.
- Record how a card reached `done` with an optional `completionDisposition` (`completed` |
  `dismissed`); legacy cards without it are treated as `completed`.
- Add the local `dismiss` mobile command kind (new Supabase migration `202607130001`) mirrored
  across the shared types, mobile projection, Swift models, and iOS controls, swipes, and activity.
- Advance the CLI contract to `0.4` with the clearer, intentionally breaking card disposition names.

## 0.3.0-keeling.4 - 2026-07-21

- Retry a prior installed, byte-identical Messages helper when macOS leaves the newly versioned
  helper path silent until timeout, while preserving the fixed read-only scope and per-attempt cleanup.

## 0.3.0-keeling.3 - 2026-07-21

- Preserve read-only Messages access across versioned installs by reusing only byte-identical
  packaged helpers when macOS Full Disk Access remains attached to a prior package path.
- Bring mobile card actions, history controls, scope controls, and control-plane navigation up to
  explicit touch-target sizing after live responsive browser QA.

## 0.3.0-keeling.2 - 2026-07-21

- Re-sign macOS release executables with stable ad-hoc identifiers after Bun compilation so Full
  Disk Access can attach to the isolated read-only iMessage helper.
- Fail macOS packaging closed unless both the main Tend binary and iMessage helper pass strict
  signature and identifier verification, including the exact staged copies that enter the archive.
- Add `tend imessage collect`, a bounded packaged launchd runner that keeps Full Disk Access on the
  sibling helper and guarantees private result-file and job cleanup.

## 0.3.0-keeling.1 - 2026-07-21

- Add the cross-feed `/now`, `/coverage`, and `/priority-ledger` control-plane surfaces while
  preserving feed-owned cards, card-scoped chat, editable artifacts, and exact approval actions.
- Add durable source profiles and attempt receipts with identity, scope, completeness, freshness,
  and explicit degraded states so incomplete coverage cannot appear as an all-clear.
- Add canonical commitments, reversible cross-source signal reconciliation, explicit-versus-implied
  promise handling, lifecycle history, split/relink correction primitives, and a bundled KTD15
  quality gate without weakening feed-local source-run provenance.
- Add deterministic priority rules, approval-gated rule changes, and an append-only evaluation
  ledger with human-readable explanations and replayable rule/judgment versions.
- Generalize connector identity verification with named `trusted_adapter`,
  `agent_host_observed`, and `prepare_only` assurance; recheck owning-card evidence during
  `action:verify` and keep legacy Gmail approvals compatible.
- Add a separate, bounded, read-only `tend-imessage-helper` and package it beside the main binary;
  the helper fails closed when macOS Full Disk Access is absent, round-trips an exact timestamp/row
  watermark, and exposes no mutation command.
- Advance the SQLite schema to `17` and the CLI contract to `0.5`.

## 0.2.0 - 2026-07-06

- Fix the public product name as Tend, consolidate runtime and agent operations under one `tend`
  command tree, remove the pre-release aliases and launchd runner, and clarify Codex
  in-app-browser onboarding.
- Split the concise product model and first-run path into `README.md`, with day-to-day operation,
  steering, approval, learning, Chronicle Pulse, and troubleshooting in `MANUAL.md`.
- Make `tend setup codex --feed <id>` and `tend setup codex --chronicle` generate dedicated
  feed-operator and Chronicle Pulse prompts, including their manual activation paths.
- Add the local On Your Mind workspace, Chronicle publication contract, privacy-filtered source
  trails, and source-backed feed influence receipts.
- Advance the CLI contract to `0.2` with context binding, publication, health, and feed-safe read
  commands.
- Add the native Tend iPhone companion, private Supabase projection, and idempotent mobile command
  bridge, with a complete magic-link and physical-device setup guide.
- Advance the SQLite schema to `14` for mirrored mobile command receipts and deterministic audit
  event ordering.
- Harden local mutations, identifiers, backup/restore, background-process ownership, and
  transactional multi-record writes.
- Add Supabase and native iOS CI coverage, reproducible source prerequisites, and complete packaged
  documentation.
- Add the Claude agent lane: lane-scoped `work:list`/`work:claim` with claimant recording, the
  `work:release` command, server-minted per-feed Claude lane bindings
  (`feed:bind --agent claude`), `feed:drain-agent`, `agent:presence`, a content-free wake ledger
  (`data/agents/claude/wake.jsonl`) with presence replay, a dock route-to-Claude toggle, a TopBar
  liveness chip, and the `/tend` arming skill.
- Advance the CLI contract to `0.3`: `work:claim` may return a token-less claimed-by report,
  `work:claim`/`work:release` accept `--session`, and capability tokens are redacted from
  workspace reads, `work:list` output, and release/reassign/retry responses (tokens now appear
  only in the claimant's claim result). `work:list` returns queued items and the caller lane's
  working items, and fresh claims rotate the queued token before returning the claim result.
- Reject mutating API requests that carry a foreign `Origin` header.

## 0.1.0 - Initial Local-First OSS Snapshot

- Local Bun executable serving UI and API from one process.
- SQLite runtime storage with readable file mirrors and backup compatibility.
- CLI-first Codex agent contract with feed binding, work queue, card, source-run, sweep, and learning commands.
- TanStack Router and TanStack Query UI structure.
- Binary build, smoke, and package scripts with bundled UI assets.
- CI verification for build, tests, binary smoke, and package creation.
- MIT license, contributor guidance, install/data/security/agent docs, runbook, and capability map.
