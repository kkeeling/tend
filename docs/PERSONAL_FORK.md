# Personal Fork and Release Stream

This repository is a public personal fork of `EveryInc/tend`. Product primitives stay generic and
reviewable; account identities, source recipes, connector credentials, priority rules, and ledger
contents stay in the operator's private `ATTENTION_HOME`.

## Repository topology

- `upstream` points to `https://github.com/EveryInc/tend.git`.
- `origin` points to the operator-owned fork.
- `main` tracks upstream and should not contain personal-only product work.
- `life-control-plane` is the deployable personal integration branch.
- Focused feature branches should isolate generic changes that may later be proposed upstream.

Verify the topology before syncing or releasing:

```sh
git remote -v
git branch --show-current
git status --short
```

## Privacy boundary

Never commit any of the following:

- mailbox addresses, phone numbers, tenant or workspace identifiers;
- transcripts, message bodies, source snapshots, or real ledger entries;
- connector tokens, OAuth material, API keys, cookies, or local permission receipts;
- runtime source recipes or private priority rules.

All of those belong under the private runtime directory. Use synthetic aliases such as
`mailbox-work-a`, `primary-work`, and `side-project` in public fixtures and documentation. Before
pushing, scan the staged diff and repository history for known private identifiers and credential
patterns.

## Bringing in upstream changes

Use a temporary integration branch so upstream intake never changes the installed release by
accident:

```sh
git fetch upstream
git switch main
git merge --ff-only upstream/main
git push origin main
git switch life-control-plane
git switch -c sync/upstream-YYYY-MM-DD
git merge main
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm tend:build
pnpm tend:smoke
```

After resolving conflicts and passing the complete test matrix, merge the sync branch into
`life-control-plane`. Building a candidate does not promote it to the installed binary.

## Contribution strategy

Keep generic primitives in focused commits with synthetic tests. When a change is useful to Tend
broadly, create an upstream proposal branch from current upstream `main` and cherry-pick only the
generic commits. Do not include personal runtime configuration, design decisions that exist only
for one operator, release tags, or private evaluation data.

## Personal prereleases

Personal releases use normal SemVer prerelease versions and are built from a clean
`life-control-plane` commit. A release candidate must pass the repository release checklist plus
the life-control-plane migration, redaction, API/CLI parity, browser, and rollback gates.

Promotion sequence:

1. Stop writes and create a verified backup of the installed binary and compatible runtime data.
2. Restore the backup into an isolated `ATTENTION_HOME` and run migration, restart, collection, and
   action-verification tests there.
3. Build, smoke-test, and package the candidate from the exact tagged commit.
4. Install the candidate, restart Tend, verify health, and complete one source refresh cycle.
5. Retain both old and new binary/data pairs until the candidate has passed the live cycle.

## Rollback

Before rollback, stop writes and export a verified archive of the current new-schema runtime so it
can be restored forward later. Then reinstall the previous binary and restore its matching
pre-cutover data snapshot. Never ask an older binary to open a newer schema. Keep both archives,
their checksums, app versions, CLI contract versions, and schema versions in the release record.

