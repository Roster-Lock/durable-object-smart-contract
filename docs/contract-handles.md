# Named contract handles

Contracts in the same roster can refer to each other by a stable handle instead
of a contract id.

## Deploying

```ts
await deploy({
  handle: "mmr",
  name: "MMR",
  source,
});
```

- `handle` defaults to `name`.
- handles are unique per roster;
- a handle cannot be changed after the first deploy;
- existing contracts without a handle fall back to their name for lookups.

## Using

```ts
export default defineContract({
  endpoints: {
    readRating: {
      run: async (input, ctx) => {
        return (await ctx.contracts.mmr.storage.ratings.get(input.player)) ?? null;
      },
    },
    updateRating: {
      run: async (input, ctx) => {
        return await ctx.contracts.mmr.call("setRating", input);
      },
    },
  },
});
```

`ctx.contracts.<handle>` contains:

- `name` — the handle;
- `id` — the underlying contract id;
- `storage` — read-only, async storage handles;
- `call(endpoint, input)` — endpoint invocation.

## Endpoint calls

- Run in the same Postgres transaction as the caller.
- Target writes participate in the caller's transaction.
- The target sees `msgSender.kind = "contract"` and the caller id
  `contract:<caller-id>`; `txOrigin` remains the original human.
- Target access rules still apply: `public` and `contract` are allowed;
  `human` and `roster-lock` are not.
- The caller's gas meter pays for the target's execution.
- A read-only (`mutates: false`) endpoint cannot invoke a mutating target.
- Calls are depth-limited and cycle-checked.
- Mutating targets are advisory-locked before invocation.

Cross-contract calls do not create a separate escrow or call log; the outer call
owns settlement. Events emitted by the target are stored against the target.

## Storage reads

`ctx.contracts.<handle>.storage` is a read-only snapshot taken at the start of
the caller's call:

- maps, arrays and values are exposed with the usual async handle methods;
- nested maps/arrays are handles; leaf values are raw values;
- writes throw;
- the snapshot does not update if the target is called later in the same call.

This is intentional: sibling reads are for inspection, while all mutation goes
through endpoints. Reading a large sibling can consume gas, so the caller pays
for the snapshot it requests.

## Scope

Handles are scoped to the roster, not globally. A future blue/green environment
should scope them to the environment so an old environment never resolves a
name to a new environment's contract. Previous-environment migration handles
should use the same read-only shape.

## Security

Handles are aliases, not capabilities. The target endpoint decides who may call
it. Direct storage writes are impossible from another contract; storage reads
are read-only and still bounded by the caller's gas and the storage limits.
