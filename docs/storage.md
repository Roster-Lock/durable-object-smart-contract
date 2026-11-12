# Storage

Related: [architecture.md](architecture.md), [gas.md](gas.md), [api.md](api.md)

Contracts never see SQL. They declare a tree of typed collections at deploy
and access it through `ctx.storage`. Every write is validated against a JSON
Schema, every nested value is a real handle, and collections cannot be created
implicitly.

```js
defineContract({
  storage: {
    config: {
      kind: "value",
      schema: { type: "object", required: ["quorum"], /* ... */ },
      initial: { quorum: 3 },
    },
    roster: {
      kind: "array",
      maxItems: 64,
      item: { type: "string", minLength: 1 },
    },
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
  endpoints: {
    vote: {
      run: async (input, ctx) => {
        const votes = await ctx.storage.votes.get(input.proposalId);
        await votes.set(ctx.msgSender.id, { support: input.support });
      },
    },
  },
});
```

## The storage namespace

`ctx.storage.<name>` is the root handle for a declared collection. There are no
constructors: an undeclared name throws, and the root handles are cached for
the call.

```js
run: async (input, ctx) => {
  const roster = ctx.storage.roster;   // StoredArray
  const config = ctx.storage.config;   // StoredValue
  const votes = ctx.storage.votes;     // StoredMap
}
```

A regular `function` endpoint also gets the context as `this`, so
`this.storage.roster` works. Arrow functions do not have their own `this`; use
the `ctx` argument there.

Native `Map` and `Array` are untouched. Use them for in-memory work; only
`ctx.storage` reaches Postgres.

## Declaration

A collection is one of three node kinds. Arrays and maps can nest arbitrarily;
a map's `value` and an array's `item` are nodes, and a `value` node is a leaf.

```ts
type StorageNode =
  | { kind: "value"; schema: JsonSchema; initial?: JsonValue; validateReads?: boolean }
  | { kind: "map"; key?: JsonSchema; value: StorageNode; maxEntries?: number; initial?: object }
  | { kind: "array"; item: StorageNode; maxItems?: number; initial?: unknown[] };
```

- A bare JSON Schema in `item`/`value` is shorthand for `{ kind: "value", schema }`.
- `version` (default 1) on a root collection guards schema changes.
- `maxItems` / `maxEntries` are enforced atomically by the counter row.
- `initial` is seeded once, on the first deploy. It is recursive: a map's
  initial object values and an array's initial items follow the same node
  shape.
- `validateReads: true` re-validates values when they are read. By default a
  value is validated when written and trusted afterwards.
- `$ref` is rejected, so a schema can never reach outside itself.

Schemas are compiled at deploy (and when the manifest is loaded). A schema
that does not compile cannot be stored. Total schema bytes, declaration depth,
collection count and path length are capped.

## StoredValue

```ts
class StoredValue {
  get(): Promise<JsonValue | undefined>;
  set(value: JsonValue): Promise<void>;
  delete(): Promise<void>;
}
```

A value collection has one JSON value. `get()` returns `undefined` when it was
never set; `set()` validates before writing.

## StoredMap

```ts
class StoredMap {
  get(key: string): Promise<JsonValue | undefined | StoredMap | StoredArray>;
  set(key: string, value: JsonValue): Promise<void>;   // leaf maps only
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;                  // deletes the subtree
  keys(limit?: number, offset?: number): Promise<string[]>;
  entries(limit?: number, offset?: number): Promise<[string, JsonValue | StoredMap | StoredArray][]>;
  size(): Promise<number>;
  clear(): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterableIterator<[string, ...]>;
}
```

The behaviour of `get`/`set` follows the declaration:

- **Leaf map** (`value: { kind: "value", ... }`): `get` returns the value or
  `undefined`; `set` writes it.
- **Nested map** (`value: { kind: "map", ... }`): `get` returns a `StoredMap`
  handle. The handle is a view; it is created without a query, and `has` tells
  you whether anything has been written under it. `set` throws - write through
  the child handle instead.
- **Map of arrays**: `get` returns a `StoredArray`.

`size()` and `keys()` only see materialised entries. A lazy child handle for a
key that was never written is empty and does not count. Keys are iterated in
lexicographic order (deterministic), not insertion order.

`delete(key)` removes the entry and, for a nested node, every row and counter
below it. Sibling entries are untouched.

## StoredArray

```ts
class StoredArray {
  get(index: number): Promise<JsonValue | StoredMap | StoredArray | undefined>;
  slice(start: number, count: number): Promise<...[]>;
  length(): Promise<number>;                    // O(1) counter

  set(index: number, value: JsonValue): Promise<void>;       // leaf arrays
  insert(index: number, items: JsonValue[]): Promise<void>;  // leaf, bulk
  push(...items): Promise<number | StoredMap | StoredArray>;
  unshift(...items): Promise<number | StoredMap | StoredArray>;
  removeAt(index: number, count?: number): Promise<JsonValue[]>;
  pop(): Promise<JsonValue | undefined>;
  shift(): Promise<JsonValue | undefined>;

  move(from: number, to: number): Promise<void>;
  moveToTop(index: number): Promise<void>;
  moveToBottom(index: number): Promise<void>;
  clear(): Promise<void>;

  [Symbol.asyncIterator](): AsyncIterableIterator<...>;
}
```

Indices are 0-based from the **top**. `push` adds at the bottom, `unshift` at
the top. `slice(start, count)` is the paged read; the page size is capped.

- **Leaf array**: `push(...items)` appends the values and returns the new
  length; `pop`/`shift` return the removed value; `removeAt` returns the
  removed values; `set` replaces one item; `insert` adds many in one statement.
- **Nested array** (`item` is a map or array node): `push()` and `unshift()`
  take no arguments and create an empty child, returning its handle:

  ```js
  const rounds = ctx.storage.rounds;
  const round = await rounds.push();     // StoredArray
  await round.push(pieceId);
  const again = await rounds.get(0);     // the same round
  ```

  `createAt(index)` creates a child at an explicit position. `removeAt`
  deletes the item and its whole subtree. `set`/`insert` throw.

- `move(from, to)` reorders in place. The moved item keeps its internal
  identity, so a handle to it (or to a nested collection inside it) stays
  valid. This is the primitive ranking needs.

- `length()` is a counter read, not a `COUNT(*)`.

## Identity and nesting

An array item has an internal `item_id` that is **not** its position. Nested
collections under an array item are addressed by that id, not by index. That is
what makes arrays of arrays and arrays of maps safe:

- moving or inserting an outer item does not change which inner collection a
  handle points at;
- removing an item deletes its subtree;
- positions can be renumbered without touching identity.

Maps are addressed by key at every level (keys are strings, at most 256 bytes,
and may not contain the internal path separator `\u001f`).

## Initial values and the init hook

`initial` is declarative and is written by the host inside the deploy
transaction, in the order the declaration gives:

```js
roster:   { kind: "array", item: { type: "string" }, initial: ["a", "b"] },
config:   { kind: "value", schema: ConfigSchema, initial: { quorum: 3 } },
rounds:   { kind: "array", item: { kind: "array", item: { type: "string" } },
            initial: [["x"], ["y", "z"]] },
```

For anything more complex, define `init`:

```js
init: async (ctx) => {
  await ctx.storage.config.set({ quorum: 3, approval: 0.6, rosterLimit: 32 });
}
```

`init` runs **once**, on the first deploy, inside the deploy transaction, with
write access and the deployer as `msgSender`. If it throws, the whole deploy rolls
back. A redeploy does not re-run it, and does not re-apply `initial`. This is
how a contract keeps its state across upgrades.

## Schema changes

The state survives a redeploy, so a schema change is a migration. The platform
enforces two things:

1. Changing a collection's declaration (schema, nesting, limits) without
   incrementing its `version` fails with `schema_changed`.
2. Writes are always validated. If you set `validateReads`, old rows are
   validated on read too; otherwise a mismatch surfaces when the value is next
   written.

Bumping the version is the author acknowledging the migration. The platform
does not rewrite existing rows; the contract should provide an owner-checked
migration endpoint that reads and rewrites them under the new schema.

## Limits

| Limit | Default |
|---|---|
| collections per contract | 64 |
| declaration depth | 8 |
| total schema bytes | 64 KiB |
| collection name | `[A-Za-z_][A-Za-z0-9_]{0,63}` |
| map key | 256 bytes, no `\u001f` |
| stored value / array item | 64 KiB |
| items per bulk add/remove | 1,000 |
| page size | 1,000 |
| array offset scanned | 100,000 |
| encoded path | 1 KiB |

## SQL layout

```
dsc_state_value (contract_id, collection, value, updated_at)
dsc_state_map   (contract_id, collection, path, key, value, updated_at)
dsc_state_array (contract_id, collection, path, item_id BIGSERIAL,
                 position DOUBLE PRECISION, value, updated_at)
dsc_state_size  (contract_id, collection, path, item_count)
```

- `path` is the encoded ancestry, e.g. `\u001fp1\u001fvoter`; root is `""`.
- A `NULL` map value or array value marks a **node**: the row exists so
  `has`/`keys`/`size` are uniform, and the child's rows live below its path.
- `dsc_state_size` caches each node's count; inserts and deletes update it in
  the same transaction, and `maxItems`/`maxEntries` are checked against it.
- Deleting a subtree uses `path = ... OR starts_with(path, prefix)`.
- The array's `item_id` is the stable identity used in nested paths.

## Gas

Every operation charges `hostCall`, `statement` per query, `rowRead` /
`rowWritten` per row, `byte` per value byte, and `schemaValidation` per
validated value or key. Bulk inserts are one statement and N row writes.
Counters add one short query per insert/delete, which is why `length()` can be
O(1). See [gas.md](gas.md).
