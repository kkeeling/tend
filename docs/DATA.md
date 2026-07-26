# Data

Tend is local-first. By default, user data lives under:

```text
~/.attention/
  attention.db
  data/
  logs/
  exports/
```

Override the runtime root with:

```sh
ATTENTION_HOME=/path/to/attention tend start
```

## Current Storage

- `attention.db` stores local runtime metadata, active workspace feed membership, editable prompt/policy documents, feed cards, routine action groups, source recipes/checkpoints, source run records, sweep state/artifacts, revision records, feed audit events, and queued/claimed/completed work items.
- `data/workspace.json` mirrors active feed membership for backup compatibility and migration from older local installs.
- `data/global-policy.md`, `data/prompts/*.md`, `data/feeds/*/policy.md`, and `data/feeds/*/prompts/*.md` mirror editable prompt/policy documents for backup compatibility and readable local debugging.
- `data/feeds/*/cards/*.json` mirrors feed cards for backup compatibility and readable local debugging.
- `data/feeds/*/routine-actions/*.json` mirrors routine action groups for backup compatibility and readable local debugging.
- `data/feeds/*/sources.json`, `data/feeds/*/sources/*.md`, and `data/feeds/*/checkpoints/*.json` mirror source recipes and checkpoints.
- Source profiles live inside `data/feeds/*/sources.json` beside their recipes and mirror expected
  provider identities, scope, cadence, and freshness policies. `data/feeds/*/source-attempts.jsonl`
  mirrors immutable collection successes and failures for that feed.
- `data/feeds/*/runs/*.json` mirrors source run records for backup compatibility and readable local debugging.
- `data/feeds/*/sweep-state.json`, `data/feeds/*/sweeps/*.json`, and `data/feeds/*/sweep-feedback/*.json` mirror sweep state, batches, and feedback traces.
- `data/revision-proposals/*.json`, `data/workspace-revisions/*.json`, and `data/feeds/*/policy-revisions/*.json` mirror revision records.
- `data/feeds/*/events.jsonl` mirrors feed audit events for backup compatibility and readable local debugging.
- `data/feeds/*/work/*.json` mirrors work items for backup compatibility and readable local debugging.
- `data/feeds/*/feed.md` stores a readable feed description. `data/feeds/*/raw/**` stores immutable raw evidence snapshots.
- `data/agents/claude/presence.json`, `data/agents/claude/wake-state.json`, and `data/agents/claude/wake.jsonl` store Claude-lane operational state. Wake lines contain only server-controlled ids/counts and never source text, instructions, or capability tokens.
- `data/workspace/commitment-candidates/*.json`, `data/workspace/commitments/*.json`, and
  `data/workspace/commitment-events.jsonl` mirror classified candidates, canonical commitments,
  minimized cross-source signal references, and reversible lifecycle/link history.
- `data/workspace/priority/rules/*.json`, `data/workspace/priority/proposals/*.json`, and
  `data/workspace/priority/ledger.jsonl` mirror immutable rulesets, proposals, and replayable
  evaluations, corrections, approvals, and overrides. Exactly one ruleset has `status: active`.
- `data/mind-context/binding.json` mirrors the one bound Chronicle publisher.
- `data/mind-context/updates/*.json` mirrors recent privacy-filtered On Your Mind publications and
  retains older records while a card references them for provenance.
  Full filtered OCR exists only in these local records and the dedicated `/mind` detail API; it is
  omitted from publication receipts, normal feed CLI output, cards, and logs.

SQLite is the authority for source profiles and attempts, source runs, commitment candidates,
canonical commitments and events, priority rules and ledger records, and the materialized Now
projection. Their file mirrors are readable derived artifacts: they are published only after the
database transaction commits and are not re-imported over a valid database on restart. A failed
post-commit publication marks the database as requiring mirror repair; the next bootstrap rewrites
derived mirrors from SQLite and removes mutable records that exist only in the mirror. If the
database is genuinely missing, bootstrap can still rehydrate it from legacy file mirrors. This
deliberately prevents a stale mirror from resurrecting state while preserving filesystem-only
migration. Use `tend backup export` and import the database snapshot for recovery; do not treat an
individual mirror file as an authoritative restore.

The database also stores a runtime readiness generation. Ordinary CLI commands require a compatible
ready generation and open SQLite without migrations, metadata churn, mirror reconciliation, or a
WAL checkpoint. Service startup and explicit maintenance own those operations. If readiness is
absent or incompatible, start Tend (or run the documented maintenance flow) rather than copying or
editing readiness metadata.

## Connector Credentials

Tend does not store Gmail, Outlook, calendar, GitHub, Slack, Teams, Granola, browser, or other
connector credentials. Those live in the local connector runtime or an OS credential store.
Expected private account, tenant, and workspace identities are runtime configuration under
`ATTENTION_HOME`; they must not be committed to a public fork. Normal workspace reads redact
execution grants, capabilities, raw connector receipts, and restricted evidence.

## iMessage/SMS Source Boundary

The optional `tend-imessage-helper` reads the fixed local Messages database directly and emits a
minimized local projection: stable message/thread identifiers, timestamp, direction, service,
sender/thread labels when present, and bounded text. It does not collect attachments, expose the
database path, accept arbitrary SQL, or offer outbound operations. The main Tend server does not
need Full Disk Access. Its exact timestamp/row watermark is accepted on the next bounded read so a
restart neither skips nor replays messages at the boundary. Imported projections and any resulting
raw snapshots remain normal private Tend evidence under `ATTENTION_HOME`; never commit them to Git.

## Backup

```sh
tend backup export
tend backup export ./tend-backup
tend stop
tend backup import ./tend-backup
```

The export command writes a backup directory with:

```text
tend-backup/
  attention.db
  data/
  manifest.json
```

`attention.db` is a consistent SQLite snapshot of the runtime authority. `data/` contains readable
file mirrors and immutable raw evidence snapshots. Export writes through a temporary staging
directory and refuses to overwrite or delete an existing destination.

Schema migrations are forward-only. Before installing a newer build, export the current runtime.
Before rehearsing a rollback, also export the migrated runtime for forward restore; then pair the
older binary with the pre-migration backup rather than asking it to open a newer schema.

Import first copies the backup into a temporary staging directory. Tend refuses to import while
the same runtime home is active, then swaps the staged database and data into place with rollback if
the swap fails. Older data-directory-only backups are still accepted; the next local runtime start
rehydrates `attention.db` from those imported file mirrors.
