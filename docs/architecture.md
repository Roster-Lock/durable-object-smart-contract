# Architecture

Related: [gas.md](gas.md), [storage.md](storage.md), [security.md](security.md),
[api.md](api.md)

## The shape of it

One contract lives in one Durable Object, and its state lives in Postgres -
the same database as the rest of the website, reached through Hyperdrive.
Every contract's rows are namespaced by `contract_id`, so one database holds
all of them plus the shared wallet.

```
          Worker (auth)                   Durable Object "contract"
   ┌─────────────────────┐        ┌──────────────────────────────────────┐
   │ verifies the session│        │  ContractService                     │
   │ passes callerId     │───────▶│    WalletLedger      ── pg ──▶ Postgres
   └─────────────────────┘  fetch │    Sandbox (QuickJS) ── host fns ──┐ │
                                  │    ContractStorage ◀───────────────┘ │
                                  └──────────────────────────────────────┘
```

| Component | File | Job |
|---|---|---|
| `ContractService` | `shared/smart-contract/src/contract.ts` | deploy, call, settle, read models |
| `Sandbox` | `shared/smart-contract/src/runtime/sandbox.ts` | one QuickJS context, async host bridge, job draining |
| `GasMeter` | `shared/smart-contract/src/gas.ts` | interrupt ticks and host charges |
| `ContractStorage` | `shared/smart-contract/src/state/collections.ts` | the declared storage tree on SQL |
| `WalletLedger` | `shared/smart-contract/src/wallet.ts` | credits, escrow, refunds, reconciliation |
| `analyzeContract` | `shared/smart-contract/src/analyze.ts` | deploy-time static checks |
| `Db` | `shared/smart-contract/src/sql/driver.ts` | one Postgres connection, `BEGIN`/`COMMIT`, `pg`/PGlite |
| `registry.ts` | `shared/smart-contract/src/registry.ts` | list contracts by roster/owner from `dsc_contract` |

## Deploy

1. Static analysis parses the source with Acorn. Forbidden globals, dynamic
   imports, timers, sandbox internals, non-async handlers and unawaited
   storage/emit calls are errors; unconditional loops, `eval` and clock/random
   use are warnings.
2. A dry run loads the source in a **read-only** sandbox inside a transaction
   that is always rolled back. Any top-level storage write fails; reads are
   allowed and awaited.
3. The dry run calls `__ds_readManifest` and the host re-validates the
   resulting JSON: endpoint names, gas limits, `public` / `human` / `contract`
   access, input schemas, events and the `storage` tree. Every JSON Schema is
   compiled here; a schema with `$ref`, too much depth or too many bytes fails
   the deploy.
4. Inside one transaction (and the contract's advisory lock) the source, a
   SHA-256 and the manifest are stored. A different owner may not replace an
   existing contract; the same owner may, and state is kept. A changed
   collection declaration requires a higher `version`; otherwise the deploy
   fails with `schema_changed`.
5. On the first deploy only, the host seeds every `initial` value and runs the
   optional `init(ctx, args)` hook with the deploy's `initArgs`, inside the
   same transaction. A failure rolls the whole deploy back.
6. The contract id, owner, roster label and init args are recorded in
   `dsc_contract`, which is also the discovery registry. The same analysis and
   manifest are available from `POST /deploy/preview` without storing anything,
   so a client can show what it is about to deploy.

Analysis is a lint, not the security boundary. The sandbox and the gas meter
are the boundary; the analyzer exists to fail fast and to show the owner what
the platform considers suspicious.

## A call, step by step

```
POST /call/vote { callerId, input }
  │
  ├─ open a connection
  ├─ resolve endpoint from the stored manifest
  ├─ check access: "public", "human" or "contract"
  ├─ maxGas = clamp(endpoint.gasLimit or default, min, host max)
  ├─ escrow = ceil(maxGas * price / 1e6)
  │
  ├─ TX 1  SET LOCAL statement_timeout; wallet -= escrow;
  │        INSERT gas_escrow                             (short, commits)
  │
  ├─ TX 2  mutates ? lock + write : no lock + read-only  ┐
  │   SET LOCAL statement_timeout                       │
  │   SELECT pg_advisory_xact_lock(contract)  (mutates) │
  │   re-read contract, verify source hash              │
  │   create QuickJS context, install host functions    │
  │   eval prelude (unmetered host code)                │
  │   eval contract source                  ← metered   │
  │     (top-level code runs read-only)                 │
  │   call __ds_invoke(endpoint, input, meta)           │
  │     (writes enabled for the endpoint)               │
  │   loop: drain jobs; await in-flight SQL; drain ...  │
  │   COMMIT, or ROLLBACK on any throw / out-of-gas     │
  └─────────────────────────────────────────────────────┘
  │
  ├─ TX 3  SET LOCAL statement_timeout; wallet += refund;
  │        DELETE escrow; INSERT call log
  │
  └─ return { result, gasUsed, gasCharged, logs }  or  throw
```

`gasUsed` is what the meter counted, clamped to `maxGas`. `gasCharged` is
`0` when the call burned out, otherwise `ceil(gasUsed * price / 1e6)`. The
refund is `escrow - gasCharged`.

### The async host bridge

Postgres is asynchronous, so the synchronous design that worked on Durable
Object SQLite (`transactionSync` around a synchronous guest) cannot work. The
replacement keeps the same guarantee - one transaction around the whole call -
without asyncify:

- each storage host function starts its query immediately and returns a
  **QuickJS promise** (a deferred);
- the outer driver loop drains the QuickJS job queue with
  `executePendingJobs`, then awaits the in-flight queries, then drains again;
- the guest's `await` continuations run on the next drain.

Everything the guest does is still inside `BEGIN`/`COMMIT`; the transaction is
simply held across real `await`s on the host. If the endpoint throws or runs
out of gas, the callback throws and the transaction rolls back.

Two consequences worth knowing:

- A guest that awaits something that can never resolve has no in-flight host
  work and no outcome; the call fails as `execution_failed` after its gas is
  charged.
- Any SQL error **poisons the Postgres transaction**, even if the contract
  catches the exception and continues. The whole call rolls back. That is the
  safe behaviour: a caught error must not leave a half-applied write.

### Why TX 1 and TX 3 are separate

The escrow must survive the rollback of TX 2, and the refund must survive the
commit of TX 2. Neither can be part of it. If the process dies between TX 2 and
TX 3, the escrow row is still there; `reconcile()` refunds escrows past their
TTL, using `FOR UPDATE SKIP LOCKED` so two reconcilers cannot refund the same
row twice.

### Read-only endpoints

An endpoint declares `mutates: false` when it only reads. The platform enforces
it:

- the sandbox's storage is read-only for the invocation, so any write throws
  and the call fails;
- the state transaction is a read-only snapshot with no advisory lock, so views
  do not queue behind mutating calls and do not block them;
- `ctx.emit` is refused, because an event is a write.

The flag is part of the manifest, so the client can warn before running a
mutating function. The default is `true`; a false claim is caught at runtime,
not trusted.

### Events

`ctx.emit(name, payload)` inserts a row in `dsc_event` **in the call's
transaction**, so a rollback removes the events with the state. The call result
carries the events, and `GET /events?after=<id>` is the polling surface for
external apps. The website can query `dsc_event` directly to build a read model
(a roster view) without calling the contract at all - the cheapest way to
serve state to readers.

### Event declarations and the roster feed

`events` is declared next to `storage`: each event has a name and a JSON
Schema. The host compiles the schema at deploy, rejects `$ref` and bad
payloads, and publishes the schema in the manifest. Event rows carry the
`contractId` of the emitter; moving to a new contract means deploying the new
one, filling it, and switching readers/writers over - there is no event
schema-version negotiation. `ctx.emit` only accepts declared events,
and the same transaction writes the event row - a rollback removes it.

The live feed is a roster-level WebSocket, not one socket per contract:

```text
GET /roster/:rosterId?contractId=A&contractId=B
```

A Worker authenticates the user, checks the paid entitlement, resolves the
roster's contracts from the registry, and forwards the upgrade to a roster hub
Durable Object. The hub subscribes to the selected contracts' committed events and fans them
out; for now the only filter is the repeated `contractId` params - a socket
receives every event from the selected contracts. Per-event filters can be
added later. Reconnects resume with `after` (per contract, since event ids are
global but the client may have seen only some). Events are emitted only after the call
fully resolves, so a rolled-back call can never leak an event. Hibernation
keeps idle sockets cheap; the event table remains the durable source for
catch-up.

The call log (`dsc_call_log`) is currently an audit summary, not a replay log:
it records caller, endpoint, status, gas and error, but not the input or result.
Full replay would need the input, the contract source hash and a starting
snapshot; that is an archive/export feature, not something to store on every
call by default. Events are the durable, ordered feed for read models; they are
not a complete state log, because the contract chooses what to emit.

### Caller identity

Every invocation gets two read-only identities:

- `ctx.msgSender` is the immediate caller, like Ethereum's `msg.sender`:
  the human on a root call, `contract:<id>` on a nested call, or
  `roster-lock` on a platform call.
- `ctx.txOrigin` is the human who started the call, like `tx.origin`. On a
  platform call it is the contract owner, who also pays. `msgSender.kind` is
  `"roster-lock"` in that case. When a third-party app acts for a user,
  `txOrigin.delegate` carries the app id for audit; the caller still looks
  human and gets no extra access.

Authorization uses `msgSender`. `txOrigin` is for attribution and audit; using
it for access is the Ethereum phishing footgun. A root call has both set to the
same human; `init` sees the deployer as both.

We deliberately do **not** keep a list of senders on the call stack. Ethereum
doesn't either: each frame already has its own `msg.sender`, and a "was X
somewhere in the stack" check is not a trust boundary. It invites reentrancy
and confused-deputy bugs, and the trace/log is the right place for the history.
If an application needs the stack for diagnostics, the host can expose a
read-only trace later; it should never be used for access.

### TypeScript and input schemas

The platform executes JavaScript in QuickJS, so that is the deploy format. The
recommended authoring path is TypeScript compiled **before** deploy (the
client's `tsc`/esbuild step), with `strict`, `noImplicitAny` and an ESLint
`no-explicit-any` rule. A typed SDK for `StoredMap`/`StoredArray`/events makes
the storage calls and payloads typed; the compiled JS is what the analyzer and
QuickJS see.

We do not run TypeScript inside the Worker: embedding a compiler adds a large
dependency and per-deploy CPU, and type erasure means it still would not
validate runtime data. Instead, every endpoint can declare an `input` JSON
Schema. It is checked by the host before escrow, published in the manifest for
clients, and independent of the authoring language. That is the runtime
counterpart to the TypeScript types.

### Contract identity and cross-contract calls

Every contract has an id (the Durable Object name). The `dsc_contract` row is
the registry, so a roster page can list its contracts and their ids without
calling any of them. A roster is not limited to one contract: `roster_id`
groups as many as it needs, and the website can fan one match report out to
each. V1 has no cross-contract state; each contract reads only its own storage,
and MMR may live in whichever of the roster's contracts the author chooses.

Cross-contract calls are the next feature, not implemented yet. The design
that fits the current engine:

- A contract calls `ctx.call(contractId, endpoint, input)`. The caller identity
  becomes `contract:<id>` instead of a user id, which is what makes a contract
  a "user" for access checks and auditing.
- The nested call runs in the **same Postgres transaction**, in a nested sandbox
  with the target's storage declarations, so state changes and events across
  both contracts commit or roll back together.
- **A nested failure is fatal.** There is no `SAVEPOINT`: if the target throws,
  the host marks the whole call failed and the transaction rolls back. A guest
  `try/catch` around `ctx.call` cannot turn that into a partial success. This
  is the simpler rule, and it matches how contract code already handles
  failures with `try/catch`.
- A depth limit and the shared gas meter bound recursion. The outer caller's
  escrow pays for the whole tree; a contract is a caller, not necessarily a
  wallet.
- **Cycles are rejected at endpoint granularity.** The call stack keeps
  `(contractId, endpoint)` pairs. `A[ep1] -> B[ep1] -> A[ep2]` is allowed;
  `A[ep1] -> B[ep1] -> A[ep1]` fails before it runs. The depth limit still
  bounds a chain of distinct endpoints. That removes the simple reentrancy and
  the A -> B -> A deadlock, while leaving useful callbacks available.
- The target contract's advisory lock must be acquired before its nested run.
  Two independent root calls that cross in opposite directions can still
  deadlock at Postgres; one is aborted and refunded. Keeping call graphs
  shallow or acyclic is the practical rule.
- `access: "human"` stays human-only, `"contract"` is for endpoints that other
  contracts may call, and `"roster-lock"` is reserved for the platform route.
  There is no owner mode: ownership is application data, stored by `init` if
  the contract needs it, so it can be transferred or shared later.

The alternative - routing the call through the target's Durable Object - would
give a clean per-contract lock but two separate transactions, so a partial
failure could leave one contract changed and the other rolled back. This design
prefers atomicity within one database.

## The storage tree

The `storage` block in `defineContract` is both the schema and the layout.
There are no implicit collections: `ctx.storage.<name>` only resolves a
declared root, and a handle carries an opaque id into the sandbox rather than
a path the guest could forge.

- **Nested maps and arrays** are handles. `await votes.get(proposalId)` returns
  a `StoredMap`; writing through it creates the parent entry lazily. Array
  items get a stable `item_id`, so a handle to an inner array stays valid when
  the outer array is reordered.
- **Paths** encode ancestry (`\u001f`-joined); a map key may never contain the
  separator. Deleting a node removes every row and counter below its path.
- **JSON Schema** validates leaves on write (and optionally on read). The
  schemas are compiled at deploy, stored in the manifest, and can never reach
  the network (`$ref` is rejected).
- **Counters** (`dsc_state_size`) make `length()`/`size()` O(1) and let
  `maxItems`/`maxEntries` fail atomically in the same transaction.
- **Bulk operations** (`insert`, `addToTop`, `addToBottom`) are one SQL
  statement, not one round trip per item.

See [storage.md](storage.md) for the API and the SQL layout.

## Failure matrix

| What happened | Contract state | Gas charged | Caller gets |
|---|---|---|---|
| Endpoint returned | committed | used | result, leftover refunded |
| Endpoint threw | rolled back | used | error, leftover refunded |
| Guest ran out of gas | rolled back | **full escrow** | error, no refund |
| Wall-clock backstop hit | rolled back | **full escrow** | error, no refund |
| Contract failed to load | rolled back | used | error, leftover refunded |
| Postgres statement timeout | rolled back | used | error, leftover refunded |
| Process died mid-call | rolled back by Postgres | unknown | escrow refunded by reconciliation |

The wall-clock backstop is deliberately billed like running out of gas: it is
a platform safety valve, not a free way to abort expensive work.

## Concurrency

Unlike SQLite, a call now has real suspension points, so two `fetch` handlers
could interleave between the escrow and the state transaction. Two mechanisms
prevent it:

1. **`blockConcurrencyWhile`** keeps the Durable Object to one request at a
   time for the whole call.
2. **`pg_advisory_xact_lock(hashtextextended(contract_id, 0))`**, taken at the
   start of the state transaction, serializes calls for a contract even if two
   isolates ever ran the same id. It is released automatically on
   commit/rollback.

The advisory lock is the real invariant; the Durable Object is the fast path.

## Deploying on Cloudflare

The package exports `SmartContractDurableObject`. A Worker routes to it with a
Durable Object binding and a migration, and the object needs a Hyperdrive
binding for Postgres:

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<hyperdrive-config-id>"

[[durable_objects.bindings]]
name = "CONTRACT"
class_name = "SmartContractDurableObject"

[[migrations]]
tag = "v1"
new_classes = ["SmartContractDurableObject"]

# workerd cannot fetch the package's .wasm from a relative URL, so bind the
# compiled module and the object will use it instead of the default loader.
[[wasm_modules]]
binding = "QUICKJS_WASM"
path = "node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm"

[vars]
CONTRACT_CONFIG = '{"gasPricePerMillion": 2, "maxGasPerCall": 5000000}'
```

`new_classes` is enough because the object no longer touches `state.storage` -
Postgres owns the data. If it ever needs the SQLite-backed storage API (for an
alarm cursor, say), use `new_sqlite_classes` instead; the two are not
interchangeable after the class has been created.

```ts
export { SmartContractDurableObject } from "@roster-lock/durable-smart-contract";
```

The Worker is the trust boundary. It authenticates the session, decides
whether a caller may deploy, and passes `ownerId` / `callerId` into the object.
The optional `SMART_CONTRACT_SECRET` is a second lock so the object rejects
requests that did not come through that Worker.

The Worker needs `nodejs_compat`: `pg` is a Node library, and the website's
services use it the same way to reach Postgres through Hyperdrive.

The contract's id is `state.id.name` (the name the Worker used with
`idFromName`), falling back to the id string. It becomes the `contract_id`
every row is keyed by.

## Limits worth knowing

- The guest gets a memory limit (default 32 MiB) and a stack limit
  (512 KiB) in addition to gas.
- Contract source is capped at 256 KiB; input and result at 256 KiB and 1 MiB.
- Storage declarations are capped at 64 collections, 8 levels, 64 KiB of
  schemas and 1 KiB per encoded path; a stored value is at most 64 KiB.
- One call may not exceed 10M gas, and an endpoint's declared limit is raised
  to at least 50k and lowered to the host maximum.
- `SET LOCAL statement_timeout` (default 1s) is set inside every transaction,
  so a hung query - including the advisory-lock wait - aborts the call instead
  of holding the object. It is transaction-local on purpose: through Hyperdrive
  the backend connection may be pooled, and a session setting could leak into
  another request.
- The Postgres transaction is the unit of atomicity.

## Why not D1

D1 is SQLite, but it is asynchronous and has no interactive transaction: its
`batch()` is transactional only when every statement is known up front. It
would keep the async bridge and give up `FOR UPDATE`/advisory locks. See
[storage-backends.md](storage-backends.md) for the comparison, including when
Durable Object SQLite would be the simpler choice.

## What is deliberately missing

- **No cross-contract calls yet.** The design is in "Contract identity and
  cross-contract calls" above. Until it lands, a contract cannot read another
  contract's rows (they are namespaced) or call its endpoints; a roster that
  needs matchmaking data gets it pushed in by an owner/oracle endpoint (see
  [living-roster.md](living-roster.md)).
- **No idempotency keys.** A retried HTTP request executes twice. That is
  safe for `set`-style endpoints but not for `addToTop`; see
  [security.md](security.md).
- **No automatic migrations.** A schema change requires a version bump, but
  the old rows are not rewritten; the contract must provide its own migration
  endpoint. `validateReads` makes stale rows fail loudly.
- **No payment provider.** `credit()` is the seam a Stripe webhook would call.
- **No generic call batching.** Bulk array operations are batched, but two
  separate `get` calls are two round trips. The wall clock and `statement_timeout`
  bound the damage; a request-level batch API is a possible optimisation.
