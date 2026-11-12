# Publishing production artifacts

Status: target design. The workspace currently exports TypeScript source for
tests and local development; publishing needs built JavaScript and declarations.

## Package outputs

Each package publishes ESM JavaScript plus `.d.ts` files, with subpath exports
preserved:

```text
@roster-lock/smart-contract
  dist/index.js
  dist/validator.js
  dist/builder.js          Node/CI only
  dist/*.d.ts

@roster-lock/living-roster
  dist/tools/index.js      contract author runtime shims + types
  dist/dev/index.js        Node/PGlite local runner
  dist/dev/builder.js      Node/CI builder
  dist/server/index.js     Worker/Durable Object surface

@roster-lock/match-making
  dist/tools/index.js
  dist/dev/index.js        browser-safe fixtures
  dist/dev/builder.js      Node/CI builder
  dist/server/index.js     Worker matchmaker runner

@roster-lock/discovery
  dist/client/index.js     browser-safe
  dist/server/index.js     Hono/Worker/Postgres

@roster-lock/smart-contract-client-builder
  dist/index.js            Node/CI/container only
  dist/validator.js        Node/CI (Acorn)
  schema/*.json

@roster-lock/smart-contract-client-host
  dist/index.js            browser-safe iframe host/bridge/CSP
```

`@roster-lock/deployed-types` is types-only: a `.d.ts` entry with no runtime
code.

`package.json` for each package should use:

```jsonc
{
  "type": "module",
  "sideEffects": false,
  "files": ["dist", "README.md", "LICENSE"],
  "exports": {
    ".": {
      "types": "./dist/tools/index.d.ts",
      "import": "./dist/tools/index.js"
    },
    "./dev": { "types": "...", "import": "..." },
    "./dev/builder": { "types": "...", "import": "..." },
    "./server": { "types": "...", "import": "..." }
  }
}
```

The tools entry is side-effect free; the server entries have only explicit
exports. `dev/builder` and `dev` have separate entries so a browser bundle
never pulls PGlite or esbuild.

## Build

- Use `tsc` (or `tsup`/Rollup) to emit ESM and declarations.
- Preserve the `@roster-lock/smart-contract/validator` and `/builder` subpaths.
- Keep `pg`, `quickjs-emscripten`, `esbuild`, `@electric-sql/pglite`, `hono` as
  peer/external dependencies where appropriate; the consuming Worker bundler
  handles them.
- The contract/matchmaker builders are Node/CI only. Do not import them from
  `server` or `tools` entries. `client-builder` is a separate Node/CI/container
  package and must never be imported by a request Worker.
- PGlite is dev-only. Do not import it from browser/server entries.
- Check with `npm pack` and a consumer smoke project that imports each entry.

## Runtime shims in published tools

The builder currently resolves runtime imports to virtual modules:

```js
// @roster-lock/living-roster
export const defineContract = __rosterDefineContract;

// @roster-lock/match-making
export const defineMatchmaker = __rosterDefineMatchmaker;
```

The bundle is wrapped so `defineContract` / `defineMatchmaker` are passed from
the prelude. This keeps the final script import-free and avoids `globalThis` in
user-visible code.

For direct consumers that do not use the builder, the published tools package
should expose real runtime functions:

```ts
export function defineContract(definition: ContractDefinition): void {
  const fn = (globalThis as { defineContract?: (value: ContractDefinition) => void })
    .defineContract;
  if (typeof fn !== "function") {
    throw new Error("defineContract is only available inside the contract runtime");
  }
  fn(definition);
}
```

The builder virtual shim takes precedence when compiling a contract, so the
published shim is for non-builder consumers and type-only imports.

## Cloudflare deployment

- Server entries are ESM for Workers.
- `wrangler` bundles the Worker; Durable Object classes and migrations are
  declared in `wrangler.toml`.
- Postgres goes through Hyperdrive; R2 holds build artifacts; the marketplace
  (discovery + share-approved) Hono app runs in a Worker.
- Do not import the test clients, `@roster-lock/*/build` or
  `@roster-lock/smart-contract/builder` from a browser entry. A Worker entry may
  import `/postgres` and `/cloudflare`; it must not import `/builder` unless it
  is the build Worker.
- QuickJS WASM is a Worker asset; keep it out of the JS bundle size calculation.
- The marketplace build pipeline (dearchive, TS/JS, bundle, validate) should run
  in a build Worker/Queue or CI, not inline in a request Durable Object.

## Versioning and release

- Use Changesets or a similar release tool; versions are semver per package.
- Publish from CI with `npm publish --provenance` (or a private registry).
- Tag the monorepo commit; record the package versions and Worker deployment.
- `workspace:*` dependencies must be resolved to real versions at pack time.
- Run typecheck, tests, build, `npm pack`, and a consumer smoke test before
  publishing.

## Artifact hygiene

- Publish `dist`, not `src`; source maps optional.
- Keep tests, fixtures and internal build scripts out of the package tarball.
- Include the LICENSE and a short README in each package.
- Verify that `@roster-lock/discovery/client` and `living-roster/tools` do not
  pull Node-only dependencies.
- Keep `@roster-lock/deployed-types` runtime-free.
