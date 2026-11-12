# API

Related: [storage.md](storage.md), [architecture.md](architecture.md)

There are two surfaces: the JavaScript a contract is written against, and the
HTTP surface the owner's client (or any caller) uses.

## Contract API

A contract is a plain script (not a module). It must call `defineContract`
once, at load time.

```js
defineContract({
  name: "living-roster",
  version: "2.0.0",
  storage: {
    config: { kind: "value", schema: ConfigSchema, initial: { quorum: 3 } },
    roster: { kind: "array", maxItems: 64, item: { type: "string" } },
    votes: {
      kind: "map",
      key: { type: "string" },
      value: {
        kind: "map",
        key: { type: "string" },
        value: { kind: "value", schema: VoteSchema },
      },
    },
  },
  init: async (ctx) => {
    await ctx.storage.config.set({ quorum: 3 });
  },
  endpoints: {
    vote: {
      gasLimit: 400_000,
      access: "public",
      run: async (input, ctx) => {
        const votes = await ctx.storage.votes.get(input.proposalId);
        await votes.set(ctx.msgSender.id, { support: input.support });
        return { ok: true };
      },
    },
  },
});
```

| Field | Required | Meaning |
|---|---|---|
| `name` | no | stored in the manifest, for display |
| `version` | no | stored in the manifest, for display |
| `storage` | no | declared collections; see [storage.md](storage.md) |
| `events` | no | declared events, each with a JSON Schema |
| `init` | no | `async (ctx, args) => void`; runs once, on the first deploy |
| `endpoints` | yes | 1 to 64 entries, keyed by endpoint name |
| `endpoints[x].run` | yes | `(input, ctx) => value \| Promise<value>` |
| `endpoints[x].gasLimit` | no | integer; `0`/absent means the host default |
| `endpoints[x].access` | no | `"public"` (default), `"human"`, `"contract"` or `"roster-lock"` |
| `endpoints[x].input` | no | JSON Schema for the call input; checked before escrow |
| `endpoints[x].mutates` | no | `false` for a view; the platform enforces read-only |

Endpoint names must match `/^[A-Za-z_][A-Za-z0-9_]{0,63}$/`.

Access modes:

| Mode | Who may call |
|---|---|
| `public` | anyone, including a future contract caller |
| `human` | an authenticated human; a contract cannot call it |
| `contract` | another contract only (reserved until cross-contract calls land) |
| `roster-lock` | the roster-lock platform only; never a user |

Ownership is not an access mode. If a contract wants to know who deployed it,
the `init` hook can store `ctx.msgSender.id`; ownership becomes ordinary
application state that can be transferred later.

`contract:` caller ids are reserved for internal cross-contract calls and are
rejected if a client tries to pass one directly. `roster-lock` endpoints are
reached through the platform route below; the normal call route always calls as
a human and cannot set the platform caller kind.

Endpoints and `init` must be **async**. Every `ctx.storage...`/`ctx.emit`
call must be awaited (or returned); the analyzer rejects unawaited effect
calls and `then`/`catch` chains. The runtime still waits for in-flight
storage work before commit and fails the call on an unhandled rejection, but
the static rule is what keeps ordering obvious.

`input` is the JSON the caller sent, already parsed. It is `null` when the
caller sent nothing.

`ctx` is:

```ts
{
  storage: Storage;   // the declared collections, see storage.md
  emit: (name: string, payload: JsonValue) => Promise<void>;
  msgSender: {
    kind: "human" | "contract" | "roster-lock";
    id: string;       // the user id, contract:<id>, or "roster-lock"
  };
  txOrigin: {
    kind: "human";
    id: string;       // the user who started the call
    delegate?: string; // third-party app id, for audit only
  };
  contract: string;   // the contract's name
  contractId: string; // this contract's id, for discovery / passing on
  callId: string;     // the escrow id for this call
  endpoint: string;   // the endpoint being run
}
```

`msgSender` is the immediate caller, like Ethereum's `msg.sender`. `txOrigin`
is the original human, like `tx.origin`. `txOrigin.delegate` is present when a
third-party app is acting with the user's grant; it is audit metadata, not
authorization. On a root call they are the same
human; a nested call would set `msgSender` to `contract:<id>` and keep
`txOrigin` as the human who paid.

The platform checks the declared `access` before the sandbox runs. For custom
rules inside an endpoint, use the sender:

```js
init: async (ctx) => {
  // Ownership is application data, not a platform mode.
  await ctx.storage.owner.set(ctx.msgSender.id);
},

configure: {
  access: "human",
  run: async (input, ctx) => {
    if ((await ctx.storage.owner.get()) !== ctx.msgSender.id) {
      throw new Error("owner only");
    }
    // ...
  },
},
```

Contracts are plain JavaScript, so TypeScript decorators are not available.
Use the `access` field for the platform-checked cases and the sender fields for
the rest. Prefer `msgSender` for authorization; `txOrigin` is for attribution,
not access control.

Every endpoint can also declare its input schema:

```js
vote: {
  input: {
    type: "object",
    required: ["proposalId", "support"],
    properties: {
      proposalId: { type: "string" },
      support: { type: "boolean" },
    },
    additionalProperties: false,
  },
  run: async (input, ctx) => { ... },
},
```

The schema is checked before escrow, so an invalid call costs nothing, and it
is published in the manifest for clients and docs.

`ctx.msgSender` is how a contract knows who is voting, paying or proposing. It
is only as trustworthy as the Worker that set it; `ctx.txOrigin` is the human
who started the call.

A regular `function` endpoint also gets the context as `this`, so
`this.storage.roster` works:

```js
run: async function (input, ctx) {
  await this.storage.roster.addToTop([input.pieceId]);
}
```

Arrow functions do not have their own `this`; use `ctx` with them.

The return value is serialized with `JSON.stringify`; `undefined` becomes
`null`. Circular values, `BigInt` and values over `maxResultBytes` fail the
call.

### Globals

Native `Map` and `Array` are untouched - use them for in-memory work.
`ctx.storage` is the only way to reach Postgres. `console.log/info/warn/error/
debug` forward to a bounded log buffer returned with a successful call.

There is no network, no filesystem, no timers, no `process`, no module loader
and no access to another contract. Promises only resolve for storage calls;
`new Promise(() => {})` never settles, and the call fails after its work is
charged.

### Initial values and `init`

`initial` is declarative and is seeded by the host inside the first deploy's
transaction. `init` is the escape hatch for anything more complex; it also
runs once, inside that transaction, with write access and the deployer as
`msgSender`/`txOrigin`.

A redeploy does not re-run `init` and does not re-apply `initial`. If `init`
throws, the deploy rolls back, including the contract row and the seeded data.

### Deploying

The platform takes the compiled JavaScript as text, not a file: the owner
client reads the build output and sends it as `source`. If the contract is
written in TypeScript, compile it first (see [typescript.md](typescript.md)).
The source is capped at 256 KiB, so a JSON body is enough; there is no
multipart route.

A deploy UI should preview first:

1. `POST /deploy/preview` with `{ ownerId, name, source }` returns the same
   analysis, manifest, storage/event declarations and endpoint input schemas
   as a deploy, without storing anything. This is where the client learns which
   endpoints mutate and what input they expect.
2. `POST /deploy` with `{ ownerId, contractId, name, handle?,
   initArgs?, source }`.

`initArgs` are passed to the contract's `init(ctx, args)` hook on the first
deploy. They are capped at 64 KiB and recorded on the contract row for audit.
`contractId` must match the Durable Object's own id. The roster is inferred
from the service/DO (`ROSTER_ID` in production) and is not part of the deploy
payload. `handle` defaults to `name` and is the stable name used by sibling
contracts; prefer a new handle such as `mmrV2` for a new version. The roster
is a discovery label (the website's roster id) stored in the shared registry.

### Events

Events are declared with JSON Schemas, like storage:

```js
defineContract({
  events: {
    PieceAdded: {
      schema: {
        type: "object",
        required: ["pieceId", "by"],
        properties: { pieceId: { type: "string" }, by: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  endpoints: {
    add: {
      run: async (input, ctx) => {
        await ctx.emit("PieceAdded", { pieceId: input.pieceId, by: ctx.msgSender.id });
      },
    },
  },
});
```

An undeclared event name, or a payload that does not match the schema, fails
the call. The schemas are published in the manifest, and every event row carries
the `contractId` of the contract that emitted it. Events are written in the same
transaction as the call: if the call rolls back, the events never existed. A call may emit at most 64 events of
16 KiB each. They are returned on the `CallResult` and can be polled with
`GET /events?after=<id>&event=<name>`; the website can also query `dsc_event`
directly to build a read model. Emitting from a read-only (`mutates: false`)
endpoint is refused.

### Schemas across redeploys

Each collection has a `version` (default 1). Changing its declaration without
incrementing the version fails with `schema_changed` (409). Bumping the version
is the author acknowledging the migration; the platform does not rewrite old
rows. Set `validateReads: true` on a value node if reads should re-validate
old data.

## HTTP surface

The Durable Object answers JSON over `fetch`. Every route except the `GET`s
and `/reconcile` is `POST` with a JSON body.

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/deploy/preview` | `{ ownerId, name, source }` | `DeployPreview` |
| `POST` | `/deploy` | `{ ownerId, contractId?, name, handle?, initArgs?, source }` | `DeployResult` |
| `POST` | `/call/:endpoint` | `{ callerId, input? }` | `CallResult` |
| `POST` | `/platform/call/:endpoint` | `{ input? }` + `x-dsc-secret` | `CallResult` |
| `GET` | `/contract` | - | `{ deployed, contract? }` |
| `GET` | `/contracts?rosterId=&ownerId=&limit=` | - | `{ contracts: ContractSummary[] }` |
| `GET` | `/events?after=&limit=&event=` | - | `{ events: ContractEvent[] }` |
| `GET` | `/calls?limit=50` | - | `{ calls: CallLogEntry[] }` |
| `GET` | `/wallet?userId=` | - | `{ userId, balance }` |
| `POST` | `/wallet/credit` | `{ userId, amount }` | `{ userId, balance }` |
| `POST` | `/reconcile` | - | `{ refunded }` |

There is no client registration step: a client is just an HTTP consumer. Access
to the object is what matters, so the Worker in front decides who may call it
(and may hold the `SMART_CONTRACT_SECRET`); the endpoint's own `access` mode
is the second gate. Anything that can reach the object can call every
`public` endpoint, so do not expose it without the Worker.

`/wallet/credit` is the seam a payment webhook uses. It is not a public
endpoint in a real deployment: the Worker should require an admin or a signed
provider webhook. The same is true for `/deploy`, which takes `ownerId` on
trust.

`/platform/call/:endpoint` is for automatic actions such as match reports. It
requires `SMART_CONTRACT_SECRET`, is disabled when that secret is not
configured, and pays from the **contract owner's** wallet. The caller kind is
`roster-lock`: `ctx.msgSender.kind === "roster-lock"` and
`ctx.txOrigin.id === ownerId`. A normal `/call` can never produce that kind. If
the owner wants to run their own reporter instead, they can use a `human`
endpoint with a stored reporter allowlist.

### DeployResult

```json
{
  "contractId": "living-roster-7f3a",
  "ownerId": "alice",
  "name": "living-roster",
  "version": "1.0.0",
  "rosterId": "roster-42",
  "sourceHash": "…",
  "manifest": {
    "name": "living-roster",
    "version": "2.0.0",
    "storage": {
      "roster": { "kind": "array", "item": { "kind": "value", "schema": { "type": "string" } }, "version": 1 }
    },
    "endpoints": {
      "vote": { "gasLimit": 400000, "access": "public", "mutates": true },
      "roster": { "gasLimit": 0, "access": "public", "mutates": false }
    },
    "hasInit": true
  },
  "analysis": { "ok": true, "issues": [], "nodes": 123 }
}
```

### CallResult

```json
{
  "contractId": "living-roster-7f3a",
  "endpoint": "vote",
  "callerId": "bob",
  "status": "ok",
  "mutates": true,
  "result": { "yes": 6, "no": 1 },
  "gasUsed": 35210,
  "gasCharged": 1,
  "logs": ["[log] …"],
  "events": [
    { "id": "17", "name": "VoteCast", "payload": { "support": true }, "callId": "…" }
  ]
}
```

### Errors

Failures are `{ ok: false, error: { code, message, issues? } }` with an HTTP
status:

| Code | Status | Meaning |
|---|---|---|
| `invalid_request` | 400 | malformed body, missing field, bad route |
| `analysis_failed` | 422 | static analysis or the deploy dry run rejected it |
| `contract_not_deployed` | 404 | no contract in this object |
| `unknown_endpoint` | 404 | not in the manifest |
| `forbidden` | 403 | an access mode rejected the caller, or a bad secret |
| `invalid_input` | 400 | the input did not match the endpoint's JSON Schema |
| `insufficient_funds` | 402 | balance cannot cover the gas escrow |
| `out_of_gas` | 400 | the call burned its whole escrow |
| `execution_failed` | 422 | the endpoint threw, or never settled |
| `contract_changed` | 409 | the contract was redeployed while a call was starting |
| `schema_changed` | 409 | a collection changed without a version bump |
| `too_large` | 413 | source, input, value or result over its limit |

When `out_of_gas` or `execution_failed` is returned, the call was still
settled: the caller has been charged and the call appears in `/calls`.

## Calling from a client

```ts
const response = await fetch(`${contractUrl}/call/vote`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-dsc-secret": SECRET,           // only if the object requires it
  },
  body: JSON.stringify({
    callerId: session.user.id,
    input: { proposalId: "p1", support: true },
  }),
});

if (!response.ok) {
  const { error } = await response.json();
  // error.code is stable; error.message is for humans
}
```

A client the owner ships should treat `gasCharged` as a receipt and show it,
and should not retry `out_of_gas` without changing the input - the retry costs
another full escrow.

## Calling from the service

```ts
const service = new ContractService({
  contractId: "living-roster",        // namespaces its rows in Postgres
  openDb: () => openPostgres(connectionString),
  config: { gasPricePerMillion: 2 },
});
await service.initialize();

await service.deploy({ ownerId, name, handle, source });
const result = await service.call({ callerId, endpoint: "vote", input });
```

`initialize()` must be awaited once (it migrates the schema and loads the
QuickJS module). Each `deploy`/`call` opens one Postgres connection and holds
one transaction across the guest execution, then closes it. `openDb` is the
only environment-specific part: production passes the Hyperdrive connection
string, tests pass a PGlite-backed `openDb`, and both use the same `Db` shape:

```ts
interface Db {
  query<T>(text: string, params?: SqlValue[]): Promise<{ rows: T[]; rowCount: number }>;
}
```

In a Worker, the Durable Object builds that from `env.HYPERDRIVE`; see
[architecture.md](architecture.md#deploying-on-cloudflare).

`ContractService` also exposes `getContract()`, `listCalls()`, `balance()`,
`credit()` and `reconcile()`; each opens its own short connection.

The tables (`dsc_contract`, `dsc_wallet`, `dsc_gas_escrow`, `dsc_call_log`,
`dsc_state_*`) are created by `migrate()`; see [storage.md](storage.md).
