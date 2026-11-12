# Gas

Related: [architecture.md](architecture.md), [storage.md](storage.md)

Gas is the unit of work a caller pays for. It is charged from two places:
the QuickJS interrupt handler (interpreter work) and the host functions
(Postgres work). Nothing else is metered.

## Units

| Constant | Default | Charged when |
|---|---|---|
| `tick` | 10,000 | every QuickJS interrupt poll |
| `baseCall` | 20,000 | when an endpoint is invoked |
| `loadPerKiB` | 200 | per KiB of contract source, on every call |
| `hostCall` | 200 | entering any storage host function |
| `statement` | 100 | each SQL statement |
| `rowRead` | 100 | per row reported read |
| `rowWritten` | 500 | per row written |
| `byte` | 1 | per byte of a stored value read or written |
| `payloadByte` | 1 | per byte of input JSON and of the endpoint result |
| `logEntry` | 100 | per `console.*` entry |
| `schemaValidation` | 500 | per value or key validated against its JSON Schema |
| `event` | 500 | per emitted event, plus its bytes |

A representative call that resolves a nested collection, reads a counter,
validates a value and writes it costs roughly **35,000 gas** in the tests
(`addPiece` on the example contract is 35,369; a paged read is 31,524). A
caller at the default price of 1 credit per 1,000,000 gas pays 1 credit for
that call, because charges round up to whole credits.

## Interrupt ticks

QuickJS calls the interrupt handler every `INTERRUPT_COUNTER_INIT` bytecode
instructions (10,000 in the bundled build). Each poll costs one `tick`, so a
loop that runs 100,000 instructions costs ten ticks. This is what makes an
infinite loop terminate, and it is also what makes gas deterministic: the same
source, the same input and the same QuickJS build produce the same tick count.

Host calls are not ticks. A single `StoredArray.slice(0, 1000)` can do more SQL
work than a million interpreter instructions, which is why it carries its own
charges.

## Escrow and settlement

```
escrowAmount = ceil(maxGas * gasPricePerMillion / 1_000_000)
gasCharged   = burned ? escrowAmount
                       : ceil(gasUsed * gasPricePerMillion / 1_000_000)
refund       = escrowAmount - gasCharged
```

- `maxGas` is the endpoint's declared `gasLimit`, or the host default when it
  declares none. It is clamped to at least `minGasLimit` (50,000) and at most
  `maxGasPerCall` (10,000,000).
- The escrow is deducted **before** the guest runs. If the balance cannot cover
  it, the call never starts and costs nothing.
- Running out of gas (or hitting the wall-clock backstop) forfeits the whole
  escrow. This is the incentive not to submit work that always burns out.
- Throwing refunds the unused gas, exactly like success. An endpoint that
  fails because of its input should not cost more than one that succeeds.
- Charges are integers: a call never costs a fraction of a credit.

With the defaults, a full 2M-gas call at price 2 costs 4 credits, and a typical
32k-gas call costs 1 credit.

## Determinism

The primary meter is deterministic:

- tick counts depend on bytecode, not on the host machine;
- SQL charges depend on the rows a query returned or affected and on the byte
  length of values - Postgres reports both deterministically;
- schema validation charges are per value, not per schema node;
- no wall-clock time is charged.

Two things are deliberately outside that guarantee:

- **The wall-clock backstop** (`hardTimeoutMs`, default 1s). It exists so a
  pathological contract cannot monopolise the object. It is not expected to
  fire, and when it does it is treated as running out of gas.
- **`Date`, `Math.random` and similar.** The analyzer warns about them; they do
  not change the gas schedule, but they do change behaviour between calls.

If a future change makes gas depend on the host, the prices in the wallet stop
meaning the same thing. Keep the meter's inputs deterministic.

## What gas does not cover

Gas bounds execution and SQL work, not memory or latency. Memory is bounded
separately by `memoryLimitBytes` (32 MiB) and `maxStackBytes` (512 KiB);
exceeding either is an execution error, not an out-of-gas event.

Latency is bounded by two clocks, not by gas: every transaction sets
`SET LOCAL statement_timeout` to `hardTimeoutMs` (1s by default), and the
driver checks the same deadline between awaited host calls. A call that is
slow because each round trip takes 5ms therefore dies on a timeout rather than
on gas - and, like running out of gas, a wall-clock timeout forfeits the
escrow. This is deliberate: gas prices the work, not the network.

Gas also does not bound the size of the database. A contract can grow its state
across many paid calls; Postgres's storage and its bill are the real ceiling.

Counters add one short statement per insert/delete, and bulk array operations
are one statement with N row writes. That is the price of O(1) `length()` and
of not paying a round trip per item. Events pay the `event` charge plus their
serialized bytes.

## Tuning

All of it lives in `ContractConfig` (`shared/smart-contract/src/types.ts`):

```ts
const service = new ContractService({
  db,
  config: {
    gasPricePerMillion: 50,
    defaultGasLimit: 500_000,
    maxGasPerCall: 5_000_000,
    gasCosts: { tick: 5_000, rowWritten: 250 },
  },
});
```

Two knobs matter most:

- **`gasPricePerMillion`** is the money. It converts gas into credits and can
  be changed between deploys without changing contract code.
- **`maxGasPerCall`** is the risk ceiling. A caller can never spend more than
  one escrow per call, and the object can never be asked to do more than this
  much interpreter work in one transaction.

`deployGasLimit` (5M) is the budget for the deploy-time dry run. It is not
billed to a wallet - deployment is a one-off owner action - but it still stops
a contract from taking forever to load.
