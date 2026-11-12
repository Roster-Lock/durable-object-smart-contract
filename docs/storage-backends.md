# Storage backends: why Postgres, and why not D1

Related: [architecture.md](architecture.md), [gas.md](gas.md)

## The question

D1 is SQLite. The old engine used SQLite and needed no async. Does moving the
contract state to D1 let us drop the async bridge?

No. D1 is an **asynchronous, network-backed** database:

- its Worker API is `await env.DB.prepare(...).all()` / `.run()` / `.batch()`;
- it runs in auto-commit, with no `BEGIN`/`COMMIT` you can hold across guest
  execution - [`batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
  is the only multi-statement transaction, and every statement in it must be
  known up front;
- each database is single-threaded, capped at 10 GB, and every query has a
  30-second ceiling ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)).

So D1 would keep the async bridge *and* force a different execution model:
buffer every write in memory, then replay the batch at the end. That gives up
`SELECT ... FOR UPDATE`, advisory locks and `SKIP LOCKED` - the things that
make the escrow and the roster safe under concurrency.

## The two kinds of async

It helps to separate them:

1. **The contract-facing API** is async by design: `value.get()` returns a
   promise, per the API sketch. This does not require an async *host*. With
   Durable Object SQLite the first version wrapped synchronous host functions
   in already-resolved promises, so contract code wrote `await` and the host
   never suspended.
2. **The host** only needs to be async if the database is asynchronous. That
   is true for Postgres and for D1. It is false only for storage that lives
   inside the Durable Object.

"Dropping async" therefore means changing where the data lives, not changing
the database product.

## Options compared

| | Durable Object SQLite | D1 | Postgres |
|---|---|---|---|
| API | synchronous (`storage.sql`, `transactionSync`) | async, auto-commit | async, interactive |
| Transaction across the guest | yes, with a synchronous guest | **no** - `batch()` only | yes, held across awaits |
| Row locks / advisory locks | SQLite's database lock | none exposed | `FOR UPDATE`, `SKIP LOCKED`, advisory |
| Shared with the website | no - private to the object | no - separate database | **yes** |
| Size ceiling | Durable Object storage | 10 GB per database | the Postgres instance |
| Concurrency | one object, one thread | one database, one thread | connection pool |
| Cross-contract queries | no | no (unless one DB) | yes, if you expose them |
| Crash recovery | SQLite journal | D1's job | Postgres WAL + reconciliation |

D1's [`batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
is genuinely transactional. The problem is what it cannot do: you cannot read
a value, run contract code, and conditionally write based on it *inside* the
same transaction unless all those statements were decided before the batch
started. Contract code decides writes while it runs.

## When Durable Object SQLite would be the right answer

If contract state does **not** need to live with the website's data, the
synchronous engine is the simpler one:

- one `transactionSync` wraps the whole guest, no async bridge at all;
- no Hyperdrive, no `pg`, no pooled-connection caveats;
- state is private to the object, which is a strong isolation story.

The costs are equally real:

- the roster data and the contract state are in different databases, so the
  website cannot join them or render a roster without calling the object;
- Durable Object storage is per contract, with its own backup/export story;
- moving a contract or querying across contracts becomes an application
  problem.

That is a product decision, not a performance one. Today the product wants
rosters, pieces, users and contract state in one place, so Postgres wins.

## Decision

Keep Postgres and keep the async bridge. The bridge is small - one deferred
promise per host call and a drain loop - and it preserves the property that
matters: **one transaction around the whole call**, with real
`FOR UPDATE`/advisory-lock semantics for money and governance.

The `Db` interface stays as a seam. A D1 backend is possible, but it is a
different engine with weaker guarantees, not a drop-in adapter:

1. writes go to an overlay, reads fall through to D1 and the overlay;
2. at the end, one `batch()` applies the overlay;
3. concurrency relies on the Durable Object serialisation, because there are
   no row locks to fall back on;
4. the wallet cannot use conditional-update + `rowCount` the way Postgres
   does, so it needs a guard statement that fails the batch when a balance is
   short.

If that backend is ever built, it should be named for what it is -
`D1ContractEngine` with "serialised, batch-committed" semantics - rather than
hiding behind the Postgres engine's guarantees.

## Sources

- [D1 `batch()` and auto-commit](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
