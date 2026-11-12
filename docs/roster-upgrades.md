# Living-roster upgrades and rollback

Status: design. Matchmaker updates use a fresh storage namespace and a previous
storage handle in `init`. A living roster is different: it has one or more
contracts, each with its own storage, plus wallet/gas and external references.
Two upgrade modes make sense.

## 1. In-place contract update (default)

The existing `ContractService.deploy` behavior:

- same contract id, same Durable Object, state kept;
- source replaced, schema changes guarded by collection `version`;
- `init` is not re-run;
- external references to the contract id stay valid;
- no data copy.

This is the cheapest option and should remain the default for compatible
changes. A migration can be a normal owner endpoint or a deploy-script call.

Rollback here is **code-only**: redeploy the previous source. Data changes made
by the new source are already committed, so the previous code must tolerate the
new data (or the migration must be reversible). The schema `version` guard is
what forces the author to acknowledge this.

## 2. Blue/green environment (for breaking changes)

Deploy a new set of contracts into fresh namespaces, migrate explicitly, then
switch the roster's active environment.

```text
environment active ──▶ environment previous ──▶ delete two-back
        ▲
        └── deploy new contracts, run init/migrate, verify, switch
```

- Each contract in the new environment gets a fresh id and storage namespace.
- The previous environment is retained for rollback.
- The new contract `init` can receive read-only async handles for the previous
  environment's contract storage.
- After the new environment is verified and active, the old active becomes
  previous; the old previous (two updates back) is cleaned up.

Retention mirrors the matchmaker:

- keep **active** and **previous**;
- on a new deployment, delete the version that becomes two-back;
- on rollback, switch the active pointer back; do not re-run `init`;
- only clean up after the new version is verified.

## Previous storage handles

For a single contract, the shape is the same as matchmakers:

```ts
init?(ctx, previous?: {
  ratings: StoredMap<number>;
  history: StoredArray<Play>;
}): Promise<void>;
```

For an environment, each contract needs its own previous handle set:

```ts
type PreviousContracts = {
  governance: {
    config: StoredValue<Config>;
  };
  ladder: {
    ratings: StoredMap<number>;
    playedAgainst: StoredMap<string[]>;
  };
};
```

The environment deploy script selects which previous contract data each new
contract receives. Contracts cannot read another contract's storage directly;
the migration runs through the environment layer.

## Why not blindly copy storage

- Contract schemas differ between versions; the new contract must transform.
- Nested maps/arrays and array item ids are storage-engine details; raw copies
  are not an API.
- A multi-contract deployment is not atomic. Deploy new contracts first,
  verify, then switch the active pointer.
- Old contract ids remain referenced by events, call logs and external apps;
  blue/green changes ids, in-place does not.
- Data rollback is only available in blue/green. In-place rollback is code-only.

## Recommended policy

- Compatible change → in-place contract update with a schema version bump.
- Breaking change or need data rollback → blue/green environment.
- Keep one previous environment; delete two-back after verification.
- The environment repo's deploy script owns ordering and migration; the
  platform provides the active/previous pointers and previous read-only
  handles.
