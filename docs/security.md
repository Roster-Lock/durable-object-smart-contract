# Security

Related: [architecture.md](architecture.md), [gas.md](gas.md), [api.md](api.md)

## Who is trusted

| Party | Trust |
|---|---|
| Platform operator (the Worker, the Durable Object) | trusted |
| Contract owner | trusted to publish code, not trusted to be correct or fair |
| Endpoint caller | untrusted |
| The contract's code | untrusted, including against itself |

The owner is the person who deployed the contract. They can replace the code
and choose the access mode of each endpoint. They cannot escape the sandbox,
read another contract's state, or spend someone else's wallet. Ownership is not
a contract access mode: if a contract needs to know its owner, `init` stores
`ctx.msgSender.id` as ordinary state, so ownership can be transferred later.

## The sandbox

Each call gets a fresh QuickJS context. The context is created with:

- no `fetch`, `XMLHttpRequest`, `WebSocket`, `require`, `process`, `navigator`
  or any other host global - QuickJS simply does not provide them;
- a 32 MiB memory limit and a 512 KiB stack limit;
- an interrupt handler that is the gas meter;
- exactly one injected object, `__ds_host`, which the prelude captures and then
  deletes from the global scope.

The host functions are the only bridge. They accept strings and numbers,
validate everything (names, keys, sizes, JSON shape, `top`/`bottom`, integer
arguments), and return JSON text, numbers, booleans or `undefined`. No host
object, SQL handle, file handle or function reference crosses the boundary.

A guest cannot obtain a reference to a host object it was not given. It can
call the prelude's classes, and it can call `host.finish` indirectly by
returning; both only affect its own result.

### Static analysis

`analyzeContract` runs before deployment and rejects:

- references to network, module, process and browser globals;
- `import(...)`, `import`/`export` syntax;
- timer globals (`setTimeout` and friends);
- the sandbox's own internal globals.

It warns about:

- unconditional `while (true)` / `for (;;)` loops with no `break`, `return`,
  `await` or `throw`;
- `eval` and the `Function` constructor (they hide code from the analyzer);
- `Math.random`, `Date.now` and `new Date` (non-determinism).

The analyzer is a lint. It exists to fail fast, to keep obviously-wrong
contracts out of the database, and to make the owner's review easier. It is
**not** what makes the sandbox safe: `eval` is warning-only yet still confined
to QuickJS, and a loop the analyzer misses still dies on gas.

## Termination

There are three independent stops:

1. **Gas.** The interrupt handler returns `true` once the limit is reached;
   QuickJS aborts with an interrupt. A loop cannot outrun it.
2. **Wall clock.** `hardTimeoutMs` (default 1s) is a backstop for anything the
   interrupt cannot see, such as a host call doing pathological SQL work.
3. **Memory and stack limits.** An allocation bomb fails the call instead of
   the process.

All three roll back the transaction. Gas and the wall clock also forfeit the
escrow, so submitting a call that always burns out is expensive.

## Money

- Escrow is deducted **before** the guest runs, so a call can never spend more
  than the caller approved.
- The `wallet.balance` column has `CHECK (balance >= 0)`; the escrow update is
  a conditional `UPDATE ... WHERE balance >= ?`, so two racing debits cannot
  overdraw it even if the serialisation assumption is ever broken.
- Refunds are computed from metered gas, clamped to the escrow amount.
- `reconcile()` refunds escrows past their TTL, which is the crash-recovery
  path. It is idempotent because it deletes the escrow row in the same
  transaction that refunds it.
- Gas that is burned is revenue, not a refund: the caller paid for work the
  platform did.

The wallet is global: one ledger is shared by every contract, so credits are
not siloed per roster. The escrow and settlement transactions are the only
places the ledger is updated, and contract code has no host function that
touches it.

## Postgres

- Every transaction sets `SET LOCAL statement_timeout` to `hardTimeoutMs`, so
  a query - including the advisory-lock wait - cannot hold the Durable Object
  indefinitely. It is deliberately transaction-local: Hyperdrive may pool the
  backend connection, so a session setting must not leak.
- `pg_advisory_xact_lock(hashtextextended(contract_id, 0))` serializes calls
  per contract at the database, independent of the object's own serialization.
  It is released by `COMMIT`/`ROLLBACK`.
- Any SQL error **aborts the transaction**, and Postgres refuses further
  queries until rollback. A contract cannot catch a SQL error and keep writing:
  the call fails and everything rolls back. This is intentional.
- A contract's rows are reached only through the `dsc_state_*` tables, always
  with `contract_id = $1`. There is no query text on the guest side to inject
  into, and every name/key/value is a bound parameter.

## Declared storage

The `storage` block is the contract's schema, and it is enforced on the host:

- **No implicit collections.** `ctx.storage.<name>` resolves a declared root
  only; an unknown name throws. There is no constructor a contract can point at
  another path.
- **Opaque handles.** The guest receives an id, not a path or a table name. It
  cannot fabricate a handle for undeclared data, and the host resolves every
  operation through the compiled declaration.
- **Bound parameters.** Names, keys and values are bound; only fixed SQL
  fragments (direction, table names) are interpolated. Map keys cannot contain
  the internal path separator, and paths are length-capped.
- **Schemas cannot reach out.** JSON Schema is compiled at deploy with a
  Worker-safe validator (no `eval`/`new Function`). `$ref` is rejected so a
  schema cannot fetch or resolve outside itself, and schema depth/bytes are
  capped.
- **Writes are validated** against the leaf schema; a failed validation throws
  and rolls back the call. `validateReads` optionally re-checks old rows.
- **Counters enforce caps atomically.** `maxItems`/`maxEntries` are checked in
  the same transaction as the insert; an over-limit add rolls back entirely.
- **Schema changes need a version bump.** A redeploy that changes a collection
  without incrementing its `version` fails, so an accidental edit cannot
  silently change the data contract.

`init` is the only code that writes during a deploy. It runs once, inside the
deploy transaction, with the deployer as `msgSender`; if it throws, the contract row
and every write are rolled back.

## Views and events

- **Access is checked before the sandbox runs.** `public`, `human`,
  `contract` and `roster-lock` are distinct. `contract:` caller ids are
  reserved; a client cannot smuggle one in through the normal call route. The
  platform route requires `SMART_CONTRACT_SECRET`, is disabled without it, and
  sets `msgSender = roster-lock` while the owner pays as `txOrigin`. A normal
  call always uses the human kind. There is no owner mode; ownership is
  application data stored at `init`.
- **Unawaited effects are rejected statically.** Endpoints and `init` must be
  async; storage/emit calls must be awaited or returned. The analyzer catches
  the common aliasing cases (a handle assigned to a local, `this.storage`), and
  the runtime is the backstop: it awaits all in-flight host work before commit
  and fails the call on an unhandled rejection. A helper that receives a handle
  as a parameter can still hide an unawaited call from the analyzer; the
  runtime then catches the failure, at the cost of a less obvious error.
- **`mutates: false` is enforced, not trusted.** The sandbox runs read-only, so
  a write throws and the call fails; the state transaction is a read-only
  snapshot with no advisory lock. The flag is in the manifest, so a client can
  warn before running a mutating endpoint.
- **Events are declared and transactional.** `ctx.emit` only accepts an event
  declared with a JSON Schema; an undeclared name or a non-matching payload
  fails the call. The row is written in the call's transaction, so a rollback
  removes it. Payloads are size-capped, event counts per call are capped, and
  names are validated. A read-only endpoint cannot emit.
- **Delegated apps are the user, plus an audit id.** A third-party app with an
  owner grant calls as the owner (`msgSender.kind = "human"`); the platform
  records `txOrigin.delegate` on the call and its events. The delegate id is
  never an access mode: contracts should not authorize on it, and the platform
  scopes the key to explicit roster/contract/endpoint entries.
- **`ctx.msgSender` and `ctx.txOrigin` are host-derived.** `msgSender` is the
  immediate caller and `txOrigin` the human who started the call; they come
  from the execution meta, not from the guest, and a contract cannot rewrite
  them. Use `msgSender` for custom access rules; `txOrigin` is attribution, not
  authorization. There is deliberately no list of senders: "was X anywhere in
  the stack" is not a trust boundary and invites reentrancy/confused-deputy
  bugs.
- **Init args are deploy input.** They are capped at 64 KiB, recorded on the
  contract row, and passed only to the one-time init hook.
- **The registry is metadata.** `roster_id` is a discovery label chosen by the
  caller; it is not an authorization boundary. Access to a contract is still
  the deploy owner (for replacement) and the endpoint access checks.

## Rate limiting and abuse

The Durable Object does not rate limit. It should sit behind a Worker that
does, keyed by user and by contract. The two costs that bound abuse today are
the per-call gas ceiling and the mandatory escrow: an attacker with no balance
cannot run anything.

## Upgrades and the owner's power

The owner can redeploy. The state is kept, so a new version sees the old data.
This is powerful and sharp:

- A malicious owner can deploy an endpoint that empties the roster (or
  transfers any value they control) - the same power they had before, but with
  no vote. Governance is the contract's job, not the platform's.
- A buggy upgrade can misread the old state. The platform forces a version
  bump when a declaration changes, but it does not rewrite rows; the contract
  must provide its own migration endpoint (and can set `validateReads` to make
  stale rows fail loudly).

If a roster's rules must be immutable, the platform needs an "immutable" flag
or a timelock on redeploy. Neither exists yet.

## Known gaps

1. **No idempotency keys.** A retried `POST /call/...` runs the endpoint again.
   That is harmless for a `set`, but not for `addToTop`. Add a
   `(callerId, idempotencyKey)` unique row and return the stored result.
2. **No pause / kill switch.** There is no way for the operator to stop a
   contract that is behaving badly without deleting the object. A `paused`
   flag checked before escrow would be cheap.
3. **Deploy authorisation lives in the Worker.** The Durable Object trusts
   `ownerId`. The optional shared secret is the only defence in depth;
   authentication belongs in front.
4. **No audit trail for deploys.** Only the current source is stored. Keeping
   every deployed version (or at least a hash chain) would make disputes
   easier.
5. **Contract source is stored in plaintext.** It is the owner's code, not a
   secret, but note that anyone who can read the object's storage can read it.
6. **No cross-contract calls.** This eliminates reentrancy, but also means a
   contract cannot verify another contract's state. Oracle endpoints are the
   current answer.
7. **Storage growth is unpriced.** Gas charges per operation, not per byte
   stored forever. `maxItems`/`maxEntries` cap individual collections, but a
   contract can add collections up to the declaration limit and grow until
   Postgres's limits. Price long-term storage before opening this to the public.
8. **Every collection operation is a round trip.** Latency is bounded by the
   statement timeout, but it is not priced. A contract that does 100 queries
   costs the same gas as one that does 10, and takes ten times as long.
9. **`reconcile` trusts the clock.** A wildly wrong clock can refund live
   escrows. The TTL (5 minutes by default) is much larger than the call
   timeout, but the clock is still an input.
10. **Result logs are dropped on failure.** Helpful for debugging, not a
    security issue.
11. **The await rule is best-effort.** A handle passed through a helper or a
    promise wrapped by hand can evade the analyzer. The runtime's "wait for all
    host work, fail on unhandled rejection" is the guarantee; the analyzer is
    the developer experience.
12. **The call log is not a replay log.** `dsc_call_log` stores a summary, not
    the input/result. Rebuilding state from calls needs an archive of inputs,
    the contract source hash and a snapshot; events are the durable read-model
    feed, but only for what the contract chose to emit.
13. **Events grow without retention.** `dsc_event` keeps every event emitted;
    a busy contract needs a retention window or an archiver before this is
    public.
11. **A crash between commit and settlement can refund a landed call.** If the
    object dies after the state transaction commits but before the refund
    transaction, reconciliation refunds the escrow even though the state change
    survived - a free call. It needs a deliberate crash at exactly that point
    and cannot be triggered by a caller. A committed-call marker written in the
    state transaction would close it; the refund would then be skipped instead
    of replayed.
12. **A failed settlement leaves the call logged only by its escrow.** If the
    refund transaction fails after a successful call, the caller sees an error
    and may retry; the endpoint runs twice. Idempotency keys would fix both
    this and the retry gap above.

## Incident checklist

- A contract is stuck or malicious: delete the Durable Object (destroys state)
  or, better, add the pause flag above before this is a real option.
- A caller's calls are failing: `GET /calls?limit=...` shows status, gas and
  the error message; `POST /reconcile` refunds crashed calls.
- A refund looks wrong: the escrow row and the call log share an id, so the
  settlement can be reconstructed from `dsc_gas_escrow` and `dsc_call_log`.
