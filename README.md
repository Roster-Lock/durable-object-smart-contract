# durable-smart-contract

Gas-metered contracts that run inside a Cloudflare Durable Object on
`quickjs-emscripten`, with state in **Postgres**. This is the platform behind
**living rosters**: democracy, matchmaking rank, money or a dictator can add
and remove pieces from a roster through public, paid, auditable endpoints.

```js
defineContract({
  name: "living-roster",
  storage: {
    votes: {
      kind: "map",                            // proposalId ->
      key: { type: "string" },
      value: {
        kind: "map",                          //   voterId -> boolean
        key: { type: "string" },
        value: { kind: "value", schema: { type: "boolean" } },
      },
    },
  },
  endpoints: {
    vote: {
      gasLimit: 400_000,
      run: async (input, ctx) => {
        const votes = await ctx.storage.votes.get(input.proposalId);
        if (await votes.has(ctx.msgSender.id)) throw new Error("already voted");
        await votes.set(ctx.msgSender.id, input.support);
        return await votes.size();
      },
    },
  },
});
```

## What it does

- **One contract per Durable Object, one row namespace in Postgres.**
  Collections are declared at deploy and typed with JSON Schema; nested maps
  and arrays are real handles, and there is no implicit collection creation.
- **Every public call is paid for up front.** The maximum gas cost is escrowed
  from the caller's wallet before the code runs.
- **Every call is one Postgres transaction.** Load, read, write, await, throw:
  all of it commits or rolls back together. The Durable Object serializes
  requests; a Postgres advisory lock enforces it again at the database.
- **Running out of gas burns the escrow; errors and successes refund the
  unused part.**
- **Contracts are analyzed before they may deploy** - forbidden globals are
  rejected, loops are flagged, and the first execution extracts the endpoint
  manifest before anything is stored.
- **Gas is deterministic** (interrupt-counted interpreter work plus explicit
  SQL charges), so prices mean the same thing on every run.
- **Initial values and `init(ctx, args)` run once, on the first deploy**,
  inside the deploy transaction; a redeploy keeps the state and never re-runs
  them. `POST /deploy/preview` returns the manifest and analysis first, so the
  owner can see endpoints and mutability before committing.
- **Endpoints must be async and effects must be awaited.** The analyzer
  rejects unawaited storage/emit calls, `then`/`catch` chains and non-async
  handlers; the runtime is the backstop.
- **Access modes separate humans, contracts and the platform.** `human`,
  `contract`, `public` and `roster-lock` are checked before the sandbox runs;
  `contract:` caller ids are reserved, and `roster-lock` endpoints are only
  reachable through the secret-protected platform route.
- **Endpoints declare whether they mutate.** `mutates: false` is enforced:
  storage is read-only, no advisory lock is taken, and the client can warn
  before a call.
- **Events are declared with JSON Schemas**, validated on emit, written in the
  call's transaction, and published in the manifest. `GET /events` is the
  polling surface; a roster-level WebSocket is the next step.
- **`ctx.msgSender` and `ctx.txOrigin`** mirror `msg.sender`/`tx.origin`: the
  immediate caller and the human who started the call. Ownership is ordinary
  state stored at `init`, not an access mode.
- **Endpoint input schemas** are checked before escrow, so an invalid call is
  free and the expected JSON is published in the manifest.
- **Reviewed deployments fail closed.** Living-roster environments and
  matchmakers must have an approved exact source hash in
  `@roster-lock/reviewed-versions`; pending, rejected and banned versions cannot
  deploy.
- **Contracts are discoverable.** The shared registry lists contracts by
  roster or owner, with their contract ids.
- **Clients are generated from endpoint JSON Schemas by default.** The
  manifest's input schemas drive RJSF forms; schema `title` / `description` and
  safe `x-roster-*` hints cover labels and widgets. List-valued fields can
  union read-only contract endpoints for their options and subtract exclude
  sources; `piece`/`user` fields show catalog pickers and `labeled-value`
  fields show fetched `{value,label}` options. No contract code runs in the
  page.
- **Match-making clients** get a key/value player card (label left, value
  right) and a ranked table sorted by MMR, with stable tie-breaking and
  optional player selection.
- **Workspace packages** separate the platform, the two products and the
  marketplace example. Products never import each other or the marketplace;
  the shared engine keeps a browser-safe root with Node/workerd code behind
  `/postgres`, `/cloudflare` and `/builder`.

## Layout

```
shared/
  smart-contract/    contract engine, storage, gas, sandbox, validator, builder
  sdk/               client SDK: DTOs, React/DOM helpers, RJSF validator
  client-host/       sandboxed iframe host, bridge, CSP, host adapters
  client-builder/    custom-client ZIP validation, packages, bundle, artifacts
  test-client/       in-memory PGlite/QuickJS harness
  deployed-types/    types available inside deployed contracts and matchmakers
  review/            reviewed versions, deploy gate, adoption vocabulary
living-roster/
  tools/src/         @roster-lock/living-roster: author types (+ /build)
  client/            schema-driven UI generated from endpoint JSON Schemas
  test-client/       in-memory local roster
  cloudflare/        Durable Object, Hyperdrive, deploy/call, adopter
match-making/
  tools/src/         @roster-lock/match-making: author types (+ /build)
  client/            matchmaker card and ranked table
  test-client/       browser-safe fixtures and run types
  cloudflare/        runner, match history, deployment/usage, adopter
marketplace/
  discovery/         catalog: repos, commits, votes, build pipeline, usage
  share-approved/    example app: approve, adopt and ban shared code
examples/            complete example contracts and client manifests
docs/                architecture, gas, storage, security, API, TypeScript, rosters, marketplaces, v2
```

Tests live with their package (`<package>/test/`); cross-product tests are in
`examples/test/`. There is no root `test/` folder.

## Run it

```bash
npm install
npm test          # engine, product, marketplace and custom-client tests
npm run typecheck
```

The core is runtime-agnostic: tests run PGlite (Postgres compiled to WASM),
production runs `pg` over Hyperdrive, and both go through the same `Db`
interface.

## Docs

- [Workspaces](docs/workspaces.md) - the six root folders and every package
- [Repository structure](docs/structure.md) - dependency rules, the adoption
  contract and the migration checklist
- [Architecture](docs/architecture.md) - how a call runs, and how one Postgres
  transaction spans an async guest
- [Gas](docs/gas.md) - units, costs, determinism, refunds
- [Storage](docs/storage.md) - declared collections, schemas, nesting, arrays
- [Storage backends](docs/storage-backends.md) - why Postgres, and why D1 does
  not remove the async
- [Security](docs/security.md) - threat model, isolation, known gaps
- [TypeScript](docs/typescript.md) - authoring in TS, compiling before deploy, strict typing
- [API](docs/api.md) - contract API and the Durable Object's HTTP routes
- [GitHub discovery](docs/github-discovery.md) - posting, workflows, approval/ban, data clearing
- [Custom clients](docs/custom-clients.md) - optional bespoke-UI tier (iframe + bundle build)
- [Schema-driven clients](docs/schema-clients.md) - default: RJSF forms from endpoint JSON Schemas
- [Client builds and runtime](docs/client-builds.md) - optional custom-client ADR, packages, frameworks, budgets, iframe trust
- [Client submission](docs/client-submission.md) - ZIP/manifest format, rules, diagnostics, CSP
- [Reviewed versions](docs/reviewed-versions.md) - fail-closed deployment allowlist for rosters and matchmakers
- [Contract handles](docs/contract-handles.md) - named sibling calls and read-only storage
- [Roster upgrades](docs/roster-upgrades.md) - in-place vs blue/green, previous storage, rollback
- [Code marketplace](docs/code-marketplace.md) - GitHub-backed roster environments and matchmakers, owner-run deploys, pinning
- [Matchmaking marketplace](docs/matchmaking-marketplace.md) - public executable matchmakers, fixtures, votes and roster-level approval
- [Publishing](docs/publishing.md) - production artifacts, shims, Cloudflare and release
- [Version 2](docs/v2.md) - deferred cross-roster MMR, listeners, delegates and retention
- [Living rosters](docs/living-roster.md) - democracy, ranking, money and the
  dictator on top of this platform

## Status

This is the execution platform, not the finished product. The example contracts,
the custom-client build/runtime path and the `share-approved` workflow are
runnable and tested; the deployable Worker, the real deploy/attach effects for
adoptions, payment-provider integration, contract upgrades, cross-contract
calls and a standard ladder projection are documented as open work rather than
implemented.
