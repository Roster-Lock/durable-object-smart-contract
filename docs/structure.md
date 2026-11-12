# Repository structure

Status: implemented. See the checklist at the end.

The repository is an npm-workspaces monorepo with six top-level folders:

```
living-roster/   packages for building and running a living roster
match-making/    packages for building and running a match maker
shared/          the platform: contract engine, client infrastructure, review
marketplace/     the sharing/discovery example application
examples/        complete roster and matchmaker examples
docs/            architecture and reference
```

## Principles

1. **A product owns its runtime.** `living-roster` and `match-making` never
   import each other. Neither imports `marketplace`.
2. **`shared/` is the platform.** The contract engine, the browser client
   SDK/host/builder, the browser test client and the reviewed-version gate are
   all platform code. They are shared by both products, but they are not a
   dumping ground: each package has one job and its own export boundary.
3. **Approval is platform code, not marketplace code.** A product's deploy
   path must be able to ask "is this exact source approved?" without importing
   the marketplace. `review` lives in `shared/` and depends only on the engine.
4. **The marketplace is an example application.** `marketplace/share-approved`
   is the only package allowed to import discovery, review and both products.
   It demonstrates the whole flow: share a GitHub URL, discuss it, have an
   admin approve it, adopt the approved version into a roster.
5. **Tests live with the code they test.** There is no root `test/` folder.
   Cross-product tests live under `examples/`.
6. **Contract authors only see short names.** Contract sources import
   `@roster-lock/living-roster`, `@roster-lock/match-making` and
   `@roster-lock/deployed-types`; the platform packages are for the platform.

## Layout

```
living-roster/
  tools/        @roster-lock/living-roster            defineContract + author types
  client/       @roster-lock/living-roster-client     default schema-driven UI
  test-client/  @roster-lock/living-roster-test-client browser harness + fixtures
  cloudflare/   @roster-lock/living-roster-cloudflare DO, Hyperdrive, deploy/call, adopt

match-making/
  tools/        @roster-lock/match-making              defineMatchmaker + author types
  client/       @roster-lock/match-making-client       card + ranked table
  test-client/  @roster-lock/match-making-test-client  browser harness + fixtures
  cloudflare/   @roster-lock/match-making-cloudflare   runner, history, adopt

shared/
  smart-contract/  @roster-lock/smart-contract         engine (browser-safe core)
  sdk/             @roster-lock/smart-contract-sdk     guest-side client DTOs + helpers
  client-host/     @roster-lock/smart-contract-client-host  iframe host, bridge, CSP
  client-builder/  @roster-lock/smart-contract-client-builder  CI build service
  test-client/     @roster-lock/smart-contract-test-client  shared browser/node harness
  deployed-types/  @roster-lock/deployed-types         types available inside deployed code
  review/          @roster-lock/reviewed-versions       approval records + deploy gate

marketplace/
  discovery/       @roster-lock/discovery              repos, commits, votes, browse
  share-approved/  @roster-lock/share-approved         example app: UI + adoption dispatch

examples/
docs/
```

The engine is not at `shared/` root: every subfolder of `shared/` is a
workspace package, so `workspaces` is a single `shared/*` glob.

## Dependency rules

```
deployed-types
smart-contract        <- sdk, client-host, client-builder, test-client
smart-contract        <- reviewed-versions
smart-contract        <- living-roster-*, match-making-*
reviewed-versions     <- living-roster-cloudflare, match-making-cloudflare
reviewed-versions     <- discovery (migration + derived status join)
discovery             <- share-approved
reviewed-versions     <- share-approved
living-roster-cloudflare, match-making-cloudflare <- share-approved
```

Not allowed:

- `living-roster-*` importing `match-making-*` or `marketplace/*`;
- `match-making-*` importing `living-roster-*` or `marketplace/*`;
- `discovery` importing either product;
- `reviewed-versions` importing discovery or a product.

These are the edges worth enforcing in a test: a product that imports the
marketplace, or discovery that imports a product, is a layering bug.

## Engine export map

The engine root must stay browser-safe so the test client can run it in a
page. Node- and workerd-only code is behind subpaths:

```
@roster-lock/smart-contract              ContractService, storage, gas, sandbox, migrate
@roster-lock/smart-contract/postgres     openPostgres (pg)
@roster-lock/smart-contract/cloudflare   SmartContractDurableObject, env types
@roster-lock/smart-contract/builder      buildJavaScript (esbuild)
@roster-lock/smart-contract/validator    validateJavaScript
```

Importing the root must not pull `pg`, esbuild or workerd bindings.

## Ownership

Three layers, three answers to "what happened?":

- **discovery** owns intent: which repo/commit was shared, its build status,
  votes, comments (linking to GitHub) and a read projection of adoptions.
  Approved/banned on a commit are derived from its linked review record, never
  stored on the commit row.
- **review** owns trust: an immutable `(kind, sourceHash)` record with
  `pending | approved | rejected | banned`. Only `approved` may deploy.
- **the products** own effect: deploying contracts, creating the matchmaker
  runner and its storage, wiring event listeners and Durable Object
  namespaces, and revoking an adoption.

`share-approved` composes them. It never stores the authoritative adoption
itself; it asks the product and projects the result for browsing.

## Adoption contract

`review` defines the shared vocabulary for adopting reviewed code (and the
generic adopter that enforces the invariants):

```ts
export type AdoptableKind = "living-roster" | "match-maker";

export interface AdoptionRequest {
  readonly rosterId: string;
  readonly kind: AdoptableKind;
  readonly sourceHash: string;   // the approved, immutable version
  readonly repo: string;
  readonly commit: string;
  readonly entry: string;
  readonly config?: Record<string, unknown>;
}
```

`createAdopter(kind, deps)` in `review` checks that the request kind matches,
calls `gate.requireApproved({ kind, sourceHash })`, then runs `apply`. An
active adoption is idempotent; `revoke` runs `revert` and records the
revocation. Each product's `cloudflare` package wraps it with a typed effect:

```ts
const rosterAdopter = createLivingRosterAdopter({
  gate,      // ReviewedVersionGate from review
  store,     // AdoptionStore (product-owned persistence)
  deploy,    // deploy contracts, return { contractId }
  revert,    // remove the DO/listeners on revoke
});
await rosterAdopter.adopt(request);            // refused unless approved
await rosterAdopter.revoke(rosterId, sourceHash);

// and createMatchMakerAdopter({ gate, store, attach, revert })
```

Adoption is refused unless the exact `(kind, sourceHash)` is approved.
Revocation exists from the start: banning a version has to reach rosters that
already adopted it. The product persists the adoption and its effect;
`discovery_usage` is a projection, never the source of truth.

## Testing

- Unit and integration tests are colocated with their package (`<package>/test/`).
- `shared/test-client` holds the harness: in-memory PGlite, engine boot,
  deploy/call, diagnostics, and a `/client` subpath for the client build
  helpers.
- `living-roster/test-client` and `match-making/test-client` hold the
  product scenarios and default fixtures; they run in the browser and in
  vitest.
- `examples/test/` holds the few tests that span products.
- A single root vitest config discovers tests across the packages; `npm test`
  runs them all.

## Migration checklist

- [x] Engine renamed to `@roster-lock/smart-contract` at
      `shared/smart-contract/`, export map split.
- [x] SDK, client host and client builder moved under `shared/` and renamed.
- [x] `schema-client` moved to `living-roster/client`.
- [x] `reviewed-versions` moved to `shared/review`.
- [x] `shared/test-client` harness added.
- [x] `living-roster/test-client` and `match-making/test-client` added with
      the `dev/` split.
- [x] Tests colocated; root `test/` deleted.
- [x] `matchmaking/` renamed to `match-making/`.
- [x] `server/` renamed to `cloudflare/` and given the adoption surface.
- [x] `adopt`/`revoke` added to both products.
- [x] Discovery split from review; `marketplace/discovery` created.
- [x] `marketplace/share-approved` example app created.
- [x] README, docs and examples updated.
- [x] `match-making/client` UI package (card + ranked table).
