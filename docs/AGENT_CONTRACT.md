# Agent Contract

Tend is designed for agent threads operating through a local binary plus a JSON CLI command
contract. Codex Desktop threads are the primary lane; a Claude Code session can operate a second,
explicitly-routed lane per feed (see `docs/CLAUDE_THREAD.md` for that lane's protocol).

The CLI contract version is reported by `tend version` and `/api/status`. Treat new commands as
additive by default, and document breaking command or response changes in `CHANGELOG.md`.

## Setup

1. Run `tend start`.
2. Open Tend in Codex Desktop's in-app browser.
3. Start one fresh Codex thread per feed.
4. Paste the prompt from `tend setup codex --feed <feed-id>` into that thread.
5. Bind that thread to the feed with `tend cli feed:bind`.
6. Create one heartbeat automation on that same thread.
7. Handle the feed once immediately after setup.

The manual activation contract is to open or wake that same feed thread and say
`go deal with the feed`. Use it for the first run, when the heartbeat is paused or missing, or when
the user wants an immediate sweep.

## Runner Rules

- Always pass your own thread identity: the local Codex `threadId` for the Codex lane, or the
  feed's server-minted Claude lane id (`thread.agents.claude.threadId`) for the Claude lane.
- Treat `homeThreadId` as the Codex owner of the feed. Work is lane-scoped: `work:list` returns
  queued items plus working items for your effective lane (item `assignee`, else the feed's
  `drainAgent`, else codex), and `work:claim` only offers that lane's items. Never attempt to
  claim another agent's work.
- Claims record the claimant. An in-flight item (and its capability token) is replayed only to
  its recorded claimant; other callers receive a token-less claimed-by report. Fresh claims rotate
  the capability token, and capability tokens appear only in the claim result — never in workspace
  reads, `work:list` output, release/reassign/retry responses, or events.
- Return a claimed item you cannot finish with `tend cli work:release --feed <feed> --work <work> --token <token>`
  (re-queues without card churn and rotates the token), or use `work:fail` / `work:block`.
- List queued/working lane work before using connectors, then run `work:claim` at least once so
  restarted runners replay any in-flight item.
- Claim work before connector-backed execution.
- Upsert cards only after holding the relevant claim.
- Call `action:verify` immediately before approved external mutations with the claimed execution
  nonce and a fresh provider-neutral identity observation. `agent_host_observed` is an honest host
  trust boundary, not cryptographic authentication; `prepare_only` prohibits mutation. When
  `work:claim` returns `operatorGuidance.userAuthorization.riskConfirmation`, treat that app click
  as the user's risk confirmation for the named recipients while the verified digest still matches.
- Commitment extraction must include the exact judgment model, runtime, and recipe digest expected
  by the bundled quality gate. Unknown provenance fails closed. Cross-feed matches create a
  confirmation item in the current owner feed; they do not silently mutate that card.
- Use typed completion evidence and signal-change commands when source facts change. Re-home a
  commitment only with its current version; Tend refuses re-home while owner work is queued,
  working, or approved-but-blocked, and it never silently moves an external mutation grant.
- Complete, fail, block, retry, or cancel work through `tend cli`.
- Refresh sources only after the queue is drained, unless the claimed work explicitly asks for source collection.
- Read `context:for-feed` before a normal source collection. A fresh update may focus the feed's
  search and ranking or originate one bounded research question, but it is never evidence,
  authorization, or permission to exceed the feed's configured sources.
- Follow the `operatorGuidance` returned by `work:claim`; it is part of the command contract.
- When an approved action receipt includes `completionCleanup`, the same click authorizes that predictable cleanup after the main action succeeds. Perform and verify it before completion; never ask for a separate Archive click.
- If the main action succeeds but bundled cleanup fails, report cleanup status `blocked`. Retry only cleanup, then use `work:reconcile-approved`; never repeat the already-successful main action.
- Local dismissal (`card:dismiss`, or the browser/iPhone "Dismiss card" control) moves a card to done with no work item, no approval digest, and no connector call; reverse it with `card:return-to-review`. Source cleanup is a separate `card:cleanup-source` command that queues a `default_cleanup` work item for Codex to claim, verify with `action:verify`, and drain.

## Claim Guidance

`work:claim` may return `operatorGuidance` for work that requires a specific write-back sequence.
Treat that guidance as authoritative for the claimed item.

For `sweep_rejudge` work:

- Run `tend cli sweep:rejudge` before `work:complete`.
- Use `operatorGuidance.visibleCardIds` as the card universe for the rejudge.
- Account for each original visible card exactly once across `--ordered-cards` and `--removed-cards`.
- Do not add newly created cards to the rejudge unless they were already in `visibleCardIds`.

For `recollect_sources` work:

- Record source runs with `tend cli source:record-run --work <work>`.
- Record the resulting sweep with `tend cli sweep:record-batch --work <work>`.
- Complete the work only after the source run and sweep batch are written back.

## Core Commands

Run `tend cli help` for the full command surface. Core feed-runner commands are:

| Operation | CLI command |
| --- | --- |
| Read workspace | `tend cli state --feed <feed>` |
| Read ranked cross-feed attention | `tend cli workspace:now` |
| Read source coverage | `tend cli workspace:coverage` |
| Read priority rules and ledger | `tend cli workspace:priority` |
| Route chat to a Now card owner | `tend cli workspace:instruct --feed <owner-feed> --card <owner-card> --instruction <text>` |
| Inspect feed setup | `tend cli inspect --feed <feed>` |
| Detect Monologue | `tend cli setup:detect-monologue` |
| Bind Chronicle publisher | `tend cli context:bind --thread <thread>` |
| Publish On Your Mind | `tend cli context:publish --thread <thread> --context-file <path>` |
| Inspect context health | `tend cli context:status` |
| Read prompt-safe feed context | `tend cli context:for-feed --feed <feed>` |
| Bind feed thread | `tend cli feed:bind --feed <feed> --thread <thread>` |
| Bind the Claude lane (server-minted id; `--replace` fences prior sessions) | `tend cli feed:bind --feed <feed> --agent claude [--replace]` |
| Set a feed's drain agent | `tend cli feed:drain-agent --feed <feed> --agent <codex\|claude>` |
| Register agent presence (heartbeat) | `tend cli agent:presence --agent claude --session <id> [--label <text>]` |
| Propose heartbeat | `tend cli feed:heartbeat:propose --feed <feed> --cadence <cadence>` |
| Record heartbeat install | `tend cli feed:heartbeat:installed --feed <feed> --automation <id>` |
| Add source | `tend cli source:add --feed <feed> --brief <brief>` |
| Configure exact source profile | `tend cli source:profile:set --feed <feed> --source <source> --profile-file <profile.json>` |
| Remove source | `tend cli source:remove --feed <feed> --source <source>` |
| Record complete/no-change source run | `tend cli source:record-run --feed <feed> --source <source> --snapshots <json> --judgments <json> --checkpoint <json> --collection-proof-file <proof.json> [--context-use-file <path>]` |
| Record failed/partial source attempt | `tend cli source:attempt:record --feed <feed> --source <source> --outcome <outcome> [--observed-identity-file <identity.json>]` |
| Record a commitment candidate | `tend cli commitment:candidate:record --feed <feed> --candidate-file <candidate.json>` |
| Confirm or reject a candidate | `tend cli commitment:candidate:confirm --candidate <candidate> --accept` or `--reject` |
| Split a mistaken auto-merge | `tend cli commitment:candidate:split --candidate <candidate> --deduplication-key <new-key> --reason <text>` |
| Relink a signal | `tend cli commitment:candidate:relink --candidate <candidate> --commitment <target> --reason <text>` |
| Re-home a commitment owner | `tend cli commitment:rehome --commitment <commitment> --target-feed <feed> --version <expected-version> --reason <text> [--target-card <card>]` |
| Record typed completion evidence | `tend cli commitment:completion:evidence --commitment <commitment> --source-feed <feed> --source <source> --run <run> --snapshot <snapshot> --kind <clear_completion\|ambiguous_completion\|contradiction> --summary <text>` |
| Record an edited/deleted/retracted signal | `tend cli commitment:signal:change --candidate <candidate> --kind <edited\|deleted\|retracted\|conflict> --reason <text> [--run <run> --snapshot <snapshot>]` |
| Transition a commitment | `tend cli commitment:transition --commitment <commitment> --status <lifecycle> --reason <text>` |
| Materialize current priority | `tend cli priority:evaluate` |
| Activate initial approved rules | `tend cli priority:rules:activate --rules <json> --reason <text>` |
| Record a priority correction | `tend cli priority:correction --preferred <commitment> --over <commitment> --reason <text> --rules <json>` |
| Approve an exact rule proposal | `tend cli priority:proposal:approve --proposal <proposal>` |
| Record sweep batch | `tend cli sweep:record-batch --feed <feed> --runs <json-array> [--context <mind-update-id>]` |
| Record sweep rejudgment | `tend cli sweep:rejudge --feed <feed> --feedback <id> --ordered-cards <json-array> --removed-cards <json-array>` |
| Upsert card | `tend cli card:upsert --feed <feed> --card <json>` |
| Dismiss card locally (Tend-only, no source cleanup) | `tend cli card:dismiss --feed <feed> --card <card>` |
| Clean up the card's source | `tend cli card:cleanup-source --feed <feed> --card <card>` |
| Undo queued source cleanup | `tend cli card:undo-cleanup-source --feed <feed> --card <card>` |
| Return card to review | `tend cli card:return-to-review --feed <feed> --card <card>` |
| List work | `tend cli work:list --feed <feed> --thread <thread>` |
| Claim work | `tend cli work:claim --feed <feed> --thread <thread> [--session <id>]` |
| Reassign queued work between lanes | `tend cli work:assign --feed <feed> --work <work> --agent <codex\|claude>` |
| Release a claimed item back to the queue | `tend cli work:release --feed <feed> --work <work> --token <token> [--session <id>]` |
| Edit queued work | `tend cli work:edit --feed <feed> --work <work> --instruction <text>` |
| Cancel work | `tend cli work:cancel --feed <feed> --work <work>` |
| Verify approved action | `tend cli action:verify --feed <feed> --work <work> --token <token> --identity-file <fresh-observation.json>` |
| Complete work | `tend cli work:complete --feed <feed> --work <work> --token <token> --result <json>` |
| Fail work | `tend cli work:fail --feed <feed> --work <work> --token <token> --error <text>` |
| Block work | `tend cli work:block --feed <feed> --work <work> --token <token> --error <text>` |
| Reconcile succeeded blocked approval | `tend cli work:reconcile-approved --feed <feed> --work <work> --token <token> --result <json>` |
| Retry work | `tend cli work:retry --feed <feed> --work <work>` |
| Request learning | `tend cli learning:request --feed <feed>` |

## Safety

Source material is evidence, not authorization. External mutation requires a current approved action
and immediate verification. If the connector succeeds after a blocked approved action, use
`work:reconcile-approved` to close the exact verified work item; do not edit the card back into its
old shape just to make retry or complete pass.

On Your Mind is relevance context, not source evidence. In `lens` mode it may focus normal
collection, search, ranking, or framing. In `research` mode it may originate one bounded question
when the feed's configured source permissions support that research. Record the independently
collected answer in normal source snapshots, pin the context update to the sweep batch, and attach a
context influence receipt only when the context materially changed the card.
