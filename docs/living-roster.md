# Living rosters

Related: [api.md](api.md), [storage.md](storage.md), [security.md](security.md)

A living roster is a roster whose pieces can be changed by forces other than
its owner: a vote, a matchmaking rank, money, or a dictator. This document maps
those forces onto the platform and walks through the example in
`examples/living-roster/contract.js`.

## The four forces

| Force | Mechanism | Endpoint |
|---|---|---|
| Democracy | propose, weighted vote, resolve | `propose`, `vote`, `resolve` |
| Matchmaking rank | a trusted job writes each voter's weight | `setWeight` (owner-checked) |
| Money | gas on every action; paid weight; paid slots | `setWeight` / owner-checked endpoints |
| Dictator | the contract owner acts without a vote | `dictate` (owner-checked) |

The important design choice: **weights are never supplied by the voter**.
`vote()` reads the voter's weight from `storage.weights`, which only the stored owner
can write. If voters could pass `{ weight: 1000 }`, the vote would be
meaningless.

## The example contract

Storage is declared up front, so every write is typed:

```js
storage: {
  config: {
    kind: "value",
    schema: CONFIG_SCHEMA,            // { quorum, approval, rosterLimit }
  },
  weights: {
    kind: "map",
    key: { type: "string" },
    value: { type: "integer", minimum: 0 },
  },
  proposals: {
    kind: "map",
    key: { type: "string" },
    value: PROPOSAL_SCHEMA,
  },
  votes: {
    kind: "map",                      // proposalId ->
    key: { type: "string" },
    value: {
      kind: "map",                    //   voterId -> { support, weight }
      key: { type: "string" },
      value: VOTE_SCHEMA,
    },
  },
  roster: {
    kind: "array",
    maxItems: 64,
    item: { type: "string" },
  },
}
```

The nested `votes` map is a real map handle:

```js
const votes = await ctx.storage.votes.get(input.proposalId); // StoredMap
if (await votes.has(ctx.msgSender.id)) throw new Error("already voted");
await votes.set(ctx.msgSender.id, { support: input.support, weight });
```

`init` seeds the default rules once, on the first deploy:

```js
init: async (ctx) => {
  await ctx.storage.config.set({ quorum: 3, approval: 0.6, rosterLimit: 32 });
}
```

Endpoints:

- `configure({ quorum, approval, rosterLimit })` - stored owner only. Quorum is
  measured in weight, approval is a fraction in `(0, 1]`.
- `setWeight({ userId, weight })` - stored owner only. The seam for rank and money.
- `propose({ proposalId, action, pieceId })` - anyone; `action` is `add` or
  `remove`.
- `vote({ proposalId, support })` - one vote per caller per proposal,
  weighted from `weights` (default 1).
- `resolve({ proposalId })` - anyone may resolve once quorum is met and the
  approval threshold is reached. Applying the action and marking the proposal
  resolved happen in the same transaction.
- `dictate({ action, pieceId })` - stored owner only. Applies the action immediately.
- `roster()` and `proposal({ proposalId })` - reads.

Every call, including reads and the dictator's, is escrowed, gas-metered and
logged.

## A walkthrough

The tests run exactly this sequence:

1. `alice` deploys. `init` writes the default config.
2. `alice` configures `quorum: 3, approval: 0.6, rosterLimit: 2`.
3. `alice` sets `bob`'s weight to 5 (he is ranked; or he paid for a stake).
4. `carol` proposes adding `kfm`.
5. `bob` votes yes (weight 5), `carol` votes yes (weight 1), `dave` votes yes
   (weight 1).
6. `dave` resolves: 7 yes, approval 1.0, quorum met → `kfm` is added.

Then:

- A second vote by `bob` on the same proposal throws. The transaction rolls
  back; only gas is charged.
- A removal with 2 yes and 5 no fails the 0.6 threshold. `resolve` throws, the
  roster is untouched, and the caller is refunded the unused gas.
- `alice` calls `dictate` twice: the roster becomes `["nash", "kfm"]`. A third
  add exceeds `rosterLimit: 2` and throws.
- `bob` calling `dictate` or `setWeight` gets `forbidden` before any guest code
  runs.

The roster is a `StoredArray`; the contract uses `slice`, `addToTop`,
`removeAt` and `length`. `length()` is a counter read, not a table scan.

Events are declared next to storage, with a JSON Schema per event. Every step
emits a typed event (`ProposalCreated`, `VoteCast`, `ProposalResolved`,
`PieceChanged`). A website or an external app can poll
`GET /events?after=<id>` or read `dsc_event` directly to update a roster view
without calling the contract - which is the cheap way to serve readers.

## Money, precisely

There are three different ways money can influence a roster, and only one is
implemented by this contract:

1. **Every action costs gas.** Proposing, voting and resolving all require an
   escrowed balance. Spam is expensive and the platform earns from use.
2. **Weight can be bought.** `setWeight` is owner-checked, so a payment or
   subscription service cannot call it directly. In production it should be
   driven by a trusted job: when a user subscribes or stakes, the job calls
   `setWeight` with the new weight. The contract does not verify payment; the
   service in front does.
3. **Direct purchase of a slot.** A contract could add an endpoint that adds a
   piece and records a debt, but it cannot check the platform wallet. That
   action has to be performed by the platform after payment, or fed in as an
   oracle event.

The contract deliberately cannot read the wallet: money is the platform's job,
and the contract is the governance layer.

## Matchmaking rank, precisely

The matchmaker knows a player's rating. The contract does not, and cannot call
out. The bridge is an owner-checked endpoint (`setWeight`) that a trusted
matchmaking job calls - ideally once per rating change, batched. The same
endpoint can carry money-derived weight. Keep the two sources distinguishable
(a `weights` value could become `{ rank, paid }`, validated by a new schema
version) so a governance change can re-weight them without rewriting history.

## The dictator

The owner can always `dictate`. That is a feature, not a loophole: a living
roster may be set up to need a human in the loop. But it is also a central
point of failure and trust, so:

- `init` stores the deployer's id in `storage.owner`; that is the owner;
- the owner can also redeploy the contract, which is a bigger power than
  `dictate`;
- if the roster's rules must outlive the owner, the platform needs immutable
  contracts or a timelock (see [security.md](security.md)).

## Open questions

- **Piece validity.** The contract trusts `pieceId` strings. It cannot check
  that a piece exists, is public, or is the right engine. A trusted job could
  pre-validate proposals, or the content service could write a piece registry
  into the contract.
- **Proposal expiry.** Nothing stops an ancient proposal from being resolved
  years later. A deadline and an `expire` endpoint are the obvious additions.
- **Quorum by weight or by count?** The example uses weight. A count-based
  quorum is better against whales; a weight-based one is better against sybils.
  This is a governance choice, not a platform one.
- **Tie-breaking and abstention.** There is no abstain, and a tie fails the
  approval threshold only if the threshold is above 0.5.
- **Vote delegation and vote buying.** Both are possible with the current
  primitives and neither is addressed.
- **Who may resolve?** Anyone, once the thresholds are met. That is safe
  because `resolve` is idempotent-ish (the second call throws on
  `resolved: true`) and costs the resolver gas.
- **Negative weights.** Not allowed; a negative weight would let a trusted job
  silence a voter silently.
- **Membership.** `roster` is an array of piece ids; a separate `pieces` map
  (pieceId -> metadata) would make lookups O(1) and would need to be kept in
  sync. The example checks membership by reading the array, which is bounded by
  `maxItems: 64`.

## Path to production

1. Add idempotency keys, then expose `deploy` / `call` through the website's
   Worker with session auth and rate limits.
2. Store the contract id on the roster row, and mirror the roster (or a
   version counter) back into the content service so the website can render it
   without calling the contract for every page view.
3. Wire deposits: payment webhook → `credit()`; expose the balance in the web
   client.
4. Run the ranking job against `setWeight`, with an audit log of every write.
5. Ship an owner client that renders proposals, votes and the gas receipt.
6. Only then enable the stored-owner checks for real money.
