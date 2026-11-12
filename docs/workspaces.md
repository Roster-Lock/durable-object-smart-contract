# Workspaces

The repository is an npm-workspaces monorepo with six top-level folders:

```
living-roster/   packages for building and running a living roster
match-making/    packages for building and running a match maker
shared/          the platform: contract engine, client infrastructure, review
marketplace/     the sharing/discovery example application
examples/        complete roster and matchmaker examples
docs/            architecture and reference
```

The rules that keep this shape honest are in
[structure.md](structure.md): products never import each other or the
marketplace, and the marketplace is the only place that imports both.

Everything is designed to run on Cloudflare in production:

- Workers / Durable Objects for execution and HTTP;
- Hyperdrive + Postgres for state;
- R2 for compiled artifacts;
- Hono for the marketplace API.

The TypeScript builder is a development/CI tool (esbuild now; Rollup can be
swapped in). It is not required in the request path.

## shared

`@roster-lock/smart-contract` is the engine. Its root entry is browser-safe;
Node- and workerd-only code sits behind subpaths:

- `.` — `ContractService`, declared storage, gas, sandbox, wallet, `migrate`;
- `./postgres` — `openPostgres` (the `pg` adapter);
- `./cloudflare` — `SmartContractDurableObject` and its env types;
- `./builder` — `buildJavaScript` (esbuild; Node/CI only);
- `./validator` — `validateJavaScript`.

`@roster-lock/smart-contract-sdk` is the guest-side client SDK: host bridge
DTOs, React context/async helpers, framework-free DOM helpers, and a CSP-safe
RJSF validator (`./rjsf`).

`@roster-lock/smart-contract-client-host` is the host side: the sandboxed
iframe host, request-id postMessage bridge, CSP/document builders, a fake host
for tests, and host adapters for `getRecentMatches`.

`@roster-lock/smart-contract-client-builder` is the Node/CI build service: ZIP
validation, build-time npm resolution with a content-addressed cache,
TS/JSX/Vue transforms, esbuild+Rollup bundling, static validation, size
budgets, R2/DB adapters and artifact publication. It is never imported by a
request Worker.

`@roster-lock/smart-contract-test-client` is the in-memory harness:

- `.` — `TestDatabase` / `freshTestDatabase` on PGlite, `LIVING_ROSTER`,
  `makeService`;
- `./client` — client build helpers for tests (`buildClientZip`, `exampleZip`,
  the local package provider).

`@roster-lock/deployed-types` holds the types available inside deployed
contracts and matchmakers (`UserId`, `MatchResult`, `QueuedPlayer`, ...).
Contract source imports the package; it is bundled away by the builder.

`@roster-lock/reviewed-versions` is the approval authority: an immutable
`(kind, sourceHash)` record with `pending | approved | rejected | banned`, a
Postgres and an in-memory repository, the deploy gate, and the adoption
vocabulary (`AdoptableKind`, `AdoptionRequest`, `createAdopter`). It depends
only on the engine's `Db`.

## living-roster

`@roster-lock/living-roster` is the entry point imported into contract code:
`defineContract`, `ContractDefinition`, `ContractContext` and related types.
`./build` exposes `buildLivingRoster` for Node/CI so esbuild never leaks into
author or browser code.

`@roster-lock/living-roster-client` is the default, schema-driven UI: RJSF
forms generated from each endpoint's input JSON Schema, safe `x-roster-*`
annotations, read-only contract sources for list fields, and confirmation for
mutating calls. No contract code runs in the page.

`@roster-lock/living-roster-test-client` runs a roster against in-process
PGlite: `createLocalRoster` gives a real `ContractService` and database for
local checks and tests.

`@roster-lock/living-roster-cloudflare` is the stable server surface imported
by a Worker: the Durable Object, Hyperdrive/`openPostgres`, the engine's
deploy/call/read models, and `createLivingRosterAdopter`.

## match-making

`@roster-lock/match-making` is imported into matchmaker code:
`defineMatchmaker`, `MatchmakerContext`, `MatchResult`, `QueuedPlayer`.
`./build` exposes `buildMatchmaker`.

`@roster-lock/match-making-test-client` holds the browser-safe fixtures and
run types (`FixtureRunner`, `MatchmakingFixture`, `MatchmakingRun`).

`@roster-lock/match-making-client` is the product UI. `MatchmakerCard` renders
key/value rows (label left, value right) built by `playerCardRows`;
`RankedTable` sorts by MMR, assigns ranks, highlights the current user and
turns names into buttons when `onSelect` is supplied. `rankLadder`,
`playerCardRows`, `formatMmr` and `formatMmrDelta` are also exported from
`./model` for hosts that render their own DOM.

`@roster-lock/match-making-cloudflare` contains `MatchmakerRunner` (a QuickJS
runner that wraps the matchmaker in a synthetic contract so declared storage,
gas and a Postgres transaction are reused), match history, the recent-match
host source, the deployment/usage interface, and `createMatchMakerAdopter`.

## marketplace

`@roster-lock/discovery` is the catalog library:

- `server/` — Postgres schema, `postRepo`, `listRepos`, `voteRepo`, the
  fetch/build/validate/upload pipeline, `prepareCommit`, `linkReviewedVersion`,
  `recordUsage` and `disableCommit`, plus the Hono catalog routes;
- `client/` — a browser-safe HTTP client for listing, posting and voting.

Approval is not stored on `discovery_commit`: the row has a
`reviewed_version_id`, and `getCommit` derives `approved`/`banned` by joining
the review record. `migrateDiscovery` also runs the review migration.

`@roster-lock/share-approved` is the example marketplace application. It binds
discovery + `ReviewedVersionService` + both product adopters:

- `approveCommit` — build, submit/approve the review, link the commit, notify;
- `adoptCommit` — build, call the product's adopter (which enforces approval),
  record the usage projection;
- `banCommit` — ban the review, revoke the adoption, remove the artifact,
  optionally clear data and notify;
- `createShareApprovedApp` mounts those routes on top of the discovery routes.

The deploy/attach effects are supplied by the app; the package owns approval,
recording and revocation.

## Allowed imports

The shared validator allows only:

```
@roster-lock/living-roster
@roster-lock/match-making
@roster-lock/deployed-types
```

Relative imports are allowed while authoring and must be bundled away. The
final bundle is validated with `mode: "bundle"`: no imports, no forbidden
globals, no `eval`/`Function`/dynamic import.

The builder treats the author packages as external/type-only. A runtime value
import from them survives into the bundle and is rejected. The next step is
real JS shims (`defineContract = globalThis.defineContract`) or bundling those
packages, so decorators/helpers can be runtime values too.

## Commands

```bash
npm install
npm run typecheck
npm test
npx vitest run marketplace/share-approved
```

## Next

1. Cloudflare adapters for `share-approved`: GitHub fetch/dearchive, R2,
   admin middleware, and a deployable Worker.
2. Real `deploy`/`attach` effects for the adopters (Durable Object namespace,
   listeners, match-result subscription).
3. Matchmaker fixture executor on top of `MatchmakerRunner`.
4. Published package artifacts and a build/release pipeline (see
   [publishing.md](publishing.md)).
