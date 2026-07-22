# Security

Tend is local-first and binds its development server to `127.0.0.1` by default.

## Trust Boundary

- The local Tend app stores workflow state and evidence.
- Codex Desktop performs connector access.
- Gmail, Outlook, calendar, Slack, Teams, Granola, browser, and other connector credentials are not
  stored by Tend. Granola API credentials, when needed, belong in a connector runtime or macOS
  Keychain and never in Tend state, CLI arguments, logs, or backups.
- External mutations require approved work and immediate `action:verify` checks. Provider-neutral
  execution grants bind the operation to an expected identity and fresh nonce. The
  `agent_host_observed` level explicitly trusts the agent/connector host and is not cryptographic
  authentication; `trusted_adapter` requires a valid nonce-bound adapter receipt; `prepare_only`
  prohibits mutation.
- Source collection is read authority only. Every configured attempt records an outcome, failed or
  partial attempts preserve the last-good checkpoint, and browser authentication fallback is
  prohibited.

## Localhost

The API is a local HTTP endpoint and must not be exposed on a public network. Browser mutations
require JSON, a loopback same-origin request, and a per-process mutation token fetched by the local
UI. These checks prevent an unrelated website from silently posting to a running Tend server;
they are not a substitute for keeping the listener on loopback.

## Agent Lanes

- Capability tokens appear exactly once: in the `work:claim` result returned to the recorded
  claimant. Workspace reads (`/api/state`, the `state` CLI), `work:list` output, events, wake
  lines, presence records, and logs never carry them.
- Lane thread ids exposed in `/api/state` are bearer credentials inside the trusted-local
  localhost boundary. The capability-token invariant prevents accidental transcript/API leakage;
  it is not a cryptographic defense against a local process that can already read the app state.
- Claude wake-ledger lines (`data/agents/claude/wake.jsonl`) contain only server-controlled
  ids and counts — never card text, instructions, or tokens. The notification channel that
  activates an agent session must not carry source-derived bytes.
- Agent presence is informational only. It lights the UI chip and triggers wake replay for
  parked work; it never authorizes claims, completions, or external mutations.

## On Your Mind

Chronicle context may include privacy-filtered OCR. Tend stores the full filtered windows only in
the local SQLite database, readable file mirror, and dedicated `/mind` detail API. Publication
receipts, cards, and feed-safe CLI reads omit full OCR.

The built-in filter removes common secrets, email addresses, long account numbers, and local user
paths. It is defense in depth, not a substitute for source restraint: publishers must include only
short windows that support a published signal.

## iMessage/SMS Helper

- Full Disk Access belongs only to the optional `tend-imessage-helper`, never the main Tend server.
- The helper opens only `~/Library/Messages/chat.db` with SQLite read-only and `query_only` controls.
- Its CLI exposes one bounded `collect` operation, no arbitrary path/query, and no send/delete API.
- Denial/timeout upgrade fallback is limited to prior installed package helpers whose bytes exactly
  match the current sibling helper; changed builds and arbitrary paths are ineligible.
- A fixed parameterized query returns a minimized projection and omits attachments. Permission and
  schema failures become explicit degraded coverage outcomes and never advance a source checkpoint.

## iPhone And Supabase

- SQLite on the Mac remains authoritative; Supabase is a disposable private projection and command
  mailbox.
- The iPhone receives no connector credentials, capability tokens, Codex thread ownership, or local
  artifact paths.
- The phone uses only a Supabase publishable key plus a Keychain-backed user session. The Supabase
  secret/service key stays on the Mac in a mode `400` or `600` owner-only config file.
- Row-level security limits every read and command RPC to `auth.uid()`.
- Commands carry feed, card, action, and work digests and are revalidated locally before mutation.
- Cached snapshots and drafts use complete file protection and are deleted on sign-out.
- On Your Mind reaches the phone only after the existing Chronicle privacy filter has run.

## Reporting

For vulnerabilities, open a private report through the repository's security advisory flow if available. If not, contact the maintainers before publishing details.
