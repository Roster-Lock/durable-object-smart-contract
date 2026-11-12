# TypeScript authoring

The controller executes **JavaScript** in QuickJS. That is the deploy format:
the analyzer parses it with Acorn, the sandbox evaluates it, and the source hash
is the code that actually runs.

TypeScript is still a good authoring language. Compile it **before** deploy, in
the owner's client or CI:

```text
contract.ts  ── tsc / esbuild ──▶  contract.js  ──▶  POST /deploy
```

The platform never sees the TypeScript. The deploy body carries the compiled
JavaScript as `source`; the manifest, analysis, storage declarations and event
schemas come from that JavaScript.

## Why not compile TypeScript in the Worker

- Embedding `tsc` or `esbuild-wasm` adds a large dependency and per-deploy CPU
  to the Durable Object; the sandbox still executes JavaScript afterwards.
- Types are erased. A TypeScript compiler cannot validate the JSON a caller
  sends at runtime.
- The deployed artifact must be inspectable. Storing the compiled JavaScript
  (and, optionally, the TypeScript alongside it) keeps that true.

If a client deploys TypeScript directly, the Worker would have to trust the
client's compiler output. A client-side build makes that explicit.

## The strict profile

The owner's build should use at least:

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "target": "ES2022",
    "module": "ESNext"
  }
}
```

and an ESLint rule:

```jsonc
{
  "rules": {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-floating-promises": "error"
  }
}
```

`no-floating-promises` is the compile-time version of the analyzer's
`promise.unawaited_effect`; the analyzer still runs on the compiled JavaScript
and is the runtime gate.

## Typed SDK, not type-only safety

A typed SDK is the useful part of TypeScript here:

```ts
const votes = storage.map<Vote>("votes");          // StoredMap<Vote>
const roster = storage.array<string>("roster");    // StoredArray<string>

endpoint("vote", {
  input: VoteInputSchema,
  mutates: true,
  run: async (input: VoteInput, ctx) => {
    const current = await votes.get(input.proposalId);
    // ...
  },
});
```

The SDK's `StoredMap`/`StoredArray` methods return `Promise`, so TypeScript
forces an `await`; `StoredMap<Vote>.set` rejects the wrong value shape at
compile time. The generated input schema is the runtime check for callers who
are not TypeScript at all.

Types and schemas serve different layers:

| Layer | Tool |
|---|---|
| authoring | TypeScript, strict, no `any` |
| deploy gate | Acorn analyzer (awaits, globals, async handlers) |
| runtime input | endpoint `input` JSON Schema, checked before escrow |
| runtime storage/events | declared JSON Schemas, checked on write |
| external consumers | manifest schemas |

## Deploying

1. Build `contract.ts` to `contract.js`.
2. `POST /deploy/preview` with the compiled source; show the manifest,
   endpoint input schemas and analysis.
3. `POST /deploy` with the compiled source and `initArgs`.

If audit needs the TypeScript, store it next to the deploy record or in R2 and
reference it by hash; the runtime intentionally only needs the JavaScript.
