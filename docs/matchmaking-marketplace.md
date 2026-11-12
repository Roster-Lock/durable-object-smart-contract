# Matchmaking marketplace

Status: design; the review gate and adoption API are implemented, the matchmaker marketplace UI is not.

Matchmaking is a separate product from the living-roster contracts, but it can
reuse the same storage primitives. A marketplace proposal contains **public,
executable matchmaker code**. Voters can read it, the platform runs it in a
sandbox, and each roster owner decides which proposal revision their roster
uses.

## What a proposal is

A proposal revision is a matchmaker source file plus metadata:

```js
defineMatchmaker({
  name: "elo-1v1",
  version: "1.0.0",
  storage: {
    ratings: {
      kind: "map",
      value: { kind: "value", schema: { type: "integer" } },
    },
    playedAgainst: {
      kind: "map",
      value: { kind: "value", schema: { type: "array", items: { type: "string" } } },
    },
  },

  // Update the matchmaker's own pairing state. The living-roster contracts
  // compute their own MMR separately; this is not sent to them.
  async handleMatchResult(result, ctx) {
    // ...
  },

  // Choose matches from the full waiting pool.
  async findOtherPlayers(pool, ctx) {
    // return { matches: [[playerA, playerB]], timedOut: [...] }
  },
});
```

The source is public for every proposal revision. The platform executes it in
the same kind of QuickJS sandbox as a contract:

- no network, filesystem, timers, `eval`, or module loader;
- host APIs for matchmaker storage, the player pool, clock and seeded
  randomness; recent opponents belong in the matchmaker's own storage;
- CPU, memory, wall-clock and output limits;
- static analysis before it can be submitted;
- a source hash and immutable revision, so running code cannot change under a
  roster.

A proposal can also include a `policy` block (mode, queue rules, parameters) as
metadata, but the **code is the source of truth**.

The authoring types map each node recursively:

- `kind: "map"` → `StoredMap<ChildValue>`;
- `kind: "array"` → `StoredArray<ChildValue>`;
- `kind: "value"` → `StoredValue<SchemaValue>`.

A child map/array is a handle; a child value is the raw value. Only a top-level
value is a `StoredValue`. Value nodes always have a schema. The runner
transforms array `value` into the contract runtime's `item` field before
compiling.

Every revision declares an SPDX license. Marketplace code must be inspectable;
official code must be OSI-approved open source (MIT or Apache-2.0 are good
defaults). The platform may fork, maintain and improve official code, with
attribution. A private algorithm is not a marketplace proposal; it can only be
a separate third-party service.

The platform's own algorithms are expected to start in the marketplace and
carry the official stamp. Official does not mean closed: it means reviewed,
tested, supported and open source, so others can improve it or decide it is not
for them.

## Runtime API

The host provides a narrow API; the matchmaker does not touch Postgres directly.

```ts
type MatchmakerContext = {
  storage: StoredMap/StoredArray;   // same declared-storage API as contracts
  now(): number;                    // virtual in tests, real in production
  random(): number;                 // seeded in tests
  queue(): Promise<QueuedPlayer[]>; // current candidate pool
  cooldownMs: number;               // host-enforced rematch window
  maxWaitMs: number;                // timeout threshold
};
```

### `handleMatchResult(result, ctx)`

Called once after a match is reported. It updates the matchmaker's own ratings,
history or queue state. It must be idempotent by `matchId` if the host can
retry. It does not compute the living roster's MMR; the contract does that from
the same raw result.

### `findOtherPlayers(pool, ctx)`

Called with the full waiting pool. It returns:

```ts
{
  matches: UserId[][];
  timedOut?: UserId[];
}
```

The reference implementation sorts by wait time, avoids recent opponents when
possible, falls back when there is no alternative, and returns timed-out
players. The host applies the matches, sends "can't find" for timed-out users,
and schedules the next attempt. A Durable Object alarm is the natural place for
that loop.

The **few-second delay should be host-side**, not a `setTimeout` in the code:

- `ctx.cooldownMs` and `ctx.maxWaitMs` let the code identify rematch windows
  and timed-out players; recent opponents belong in the matchmaker's own
  storage, not in a host context field;
- the host waits a few seconds between searches and re-calls
  `findOtherPlayers`;
- tests use a virtual clock, so the cooldown is instant and deterministic.

This avoids tying up a Worker with a sleep and keeps the policy testable. If a
matchmaker truly needs an in-code wait, expose a bounded `ctx.sleep(ms)` with a
small maximum, but the default should be the host cooldown.

### Updating a matchmaker

There is no storage schema `version` on a matchmaker. When a roster switches to
a new matchmaker deployment, the new `init` receives the previous deployment's
storage as **read-only async handles**, not a synchronous snapshot:

```ts
async init(ctx, previous) {
  const oldRating = previous ? await previous.ratings.get("alice") : undefined;
  await ctx.storage.ratings.set("alice", oldRating ?? 1000);
}
```

The previous handles use the same `StoredMap`/`StoredArray`/`StoredValue`
shapes. The deployment service passes the previous storage declaration + data
to the runner, which builds the handles from the retained namespace. The new
deployment gets a fresh storage namespace; if `init` ignores `previous`, it
starts empty. `init` runs once per fresh deployment, not on every cycle.

Keep the active and previous deployments for rollback. On the next update, the
old previous deployment becomes the two-back version; clear its data and R2
artifact only after the new deployment is active and verified. A rollback swaps
the active pointer back to the retained previous deployment without re-running
`init`.

### Match history

The platform records every finished match in `dsc_match_history`, independent
of the matchmaker's algorithm storage. It stores the match id, roster,
deployment, participants, finish timestamp and the raw `MatchResult`. History
is sorted by timestamp, with a GIN index on participants so a user's matches
can be queried efficiently. Use `listMatchHistory({ rosterId, userId })` from
`@roster-lock/match-making-cloudflare`; do not rely on a particular algorithm's
`playedAgainst` or ratings layout for history.

## Review gate

Matchmaker deployments use the same reviewed-version allowlist as living-roster
environments: only an approved exact source hash may deploy. See
[reviewed-versions.md](reviewed-versions.md).

## Marketplace workflow

```text
draft ──▶ submitted ──▶ comments / votes / test runs
                   │
                   ├── author revision ──▶ new immutable revision
                   │
                   ├── platform review ──▶ official stamp on a revision
                   │
                   └── roster owner pins a revision
```

- Comments attach to a proposal or revision.
- Up/down votes are advisory, one per user per proposal. They help discovery;
  they do not approve code for every roster.
- **Approval is at the roster level.** The owner selects a proposal revision
  for their roster; that is the approval that matters.
- The platform may also give a revision the **official stamp**: reviewed,
  tested, supported and open source. Official is a quality signal and a pricing
  tier, not an automatic roster selection.
- A selected revision is **pinned**. If the author updates the code, the roster
  keeps running the pinned revision until the owner re-approves the new one.
- Approved/selected matchmakers can be changed; changing the matchmaker or
  algorithm resets its queue/ratings. The living-roster contracts keep their
  state and their own MMR.

## Official vs community

| | Official | Community |
|---|---|---|
| review | platform review and tests | no platform review |
| source | public, open source | public, inspectable |
| pricing | included/reduced for subscribers | roster pays per use |
| support | platform-maintained | author/roster |
| roster approval | still required | required |
| badge | revision-level official stamp | none |

Votes and comments apply to both. A community algorithm can be forked from an
official one and submitted back; the official stamp applies to the exact
revision, so an update must be reviewed again. A malicious or broken revision
can be delisted and a running matchmaker disabled; existing roster pins do not
override a security delist.

## Subscriptions and revenue

Only players with an active subscription can enter matchmaking. The platform
checks this before queueing; it is not the matchmaker's job, and the matchmaker
code never handles payments.

A simple model:

- **Player subscription** covers matchmaking access and the official algorithms.
- **Official algorithms** are free or heavily reduced for rosters; the platform
  pays for their compute from the subscription pool.
- **Community algorithms** are chosen by the roster owner, who pays a per-match
  or monthly fee set by the author within platform bounds. The platform takes a
  fee and the author gets a revenue share; the roster owner can subsidize the
  algorithm for its players or pass the choice to them.
- **Revenue sharing** can also rebate roster owners from the subscription pool
  based on active players/matches, and pay community authors for usage. The
  exact split is a product decision; the important part is that it is a
  platform billing ledger, not contract state.
- Matchmaking payments and gas are separate. A contract call still escrows gas;
  matchmaking fees are website billing.

This makes the official stamp meaningful in both quality and cost: an
algorithm must be approved before a roster can adopt it; the product adopter
checks the exact source hash.

The marketplace is a normal authenticated website service, not a smart contract
and not the living-roster vote. It can live in Postgres; no gas is involved.

## Test fixtures

The same storage classes and `Db` interface used by contracts can run the
matchmaker locally or in the marketplace's "run" view. Use PGlite for local
tests and a deterministic clock/random seed for repeatability.

Shared fixture scenarios:

```ts
type MatchmakingFixture = {
  players: QueuedPlayer[];
  matches: MatchResult[];
  now: number;
  seed: number;
};
```

Common cases to ship:

- a normal skill spread;
- a bad player who got lucky and beat a great player;
- a great player who lost to a bad player;
- a low-population queue where few players are near the player's skill;
- a great, average and bad player returning after a long inactivity gap.

Each fixture should assert observable outcomes: who was matched, how ratings
changed, whether rematches were avoided, and how long the queue waited. The
marketplace shows the latest test results for each revision so voters can see
behaviour, not just read code.

Fixtures and expected snapshots can be shared as a package so authors can run
the same cases locally.

## Execution and safety

- QuickJS isolate per run; the same no-network/no-filesystem rules as contracts.
- Time, memory, CPU and output limits; a matchmaker that runs away is killed and
  the roster stays on its previous revision.
- Static analysis rejects forbidden globals, dynamic import, unbounded loops and
  oversized source before submission.
- No access to another roster's storage; each matchmaker run is namespaced by
  roster/matchmaker.
- The host owns the player pool and match results; the code only reads or
  updates its own storage and returns candidates.
- The platform can delist a revision or disable a matchmaker; the roster owner
  can switch back.

## Game capabilities

Games differ in what data they can provide:

```ts
type GameCapabilities = {
  gameId: string;
  matchmaking: boolean;
  officialReports: boolean;
  thirdPartyObservers: boolean;
};
```

- **Ikemen-Go** currently has `matchmaking: false` and
  `thirdPartyObservers: false`: third parties cannot watch matches. Do not show
  the marketplace or accept matchmaker proposals for it. The living roster can
  still run with owner-set weights or no ranked weights.
- A game with official reports but no observers can use official matchmaking and
  the marketplace code, but not third-party observers.
- A game with observer access can opt into third-party matchmaking services
  later.

The marketplace rejects a proposal for a game whose capabilities do not support
it.

## Integration with the living roster

- The matchmaker pairs players and updates its own pairing state.
- The platform reports the **raw match result** to the roster's contract(s).
  Contracts do **not** receive `mmrAfter`; each contract computes its own MMR
  from the result.
- The matchmaker's ratings are for finding matches, not for voting power. The
  contract's MMR is separate and survives a matchmaker change.
- If the roster changes matchmaker/algorithm, reset the matchmaker's queue and
  ratings; the contracts stay as they are.
- A roster can have multiple contracts; the platform fans the result out to the
  ones the roster selects.

This keeps the contract environment stable while matchmaking experiments come
and go.

## V2: third-party matchmaking services

The marketplace is for code that runs on the platform. A separate service
directory can list external matchmakers:

- only for games with `thirdPartyObservers: true`;
- service endpoints/policies listed;
- roster owner grants a narrow API key per roster/contract/endpoints;
- quality and latency are the user's choice;
- no open global marketplace in v1.

Ikemen-Go does not qualify. The code marketplace can still exist for games where
the official service can report results.
