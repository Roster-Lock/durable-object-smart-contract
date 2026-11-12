# Custom client builds and runtime (ADR)

Status: implemented in `shared/client-builder/` and `shared/client-host/`. This path is
now optional: schema-driven clients ([schema-clients.md](schema-clients.md))
are the recommended default because they avoid executing third-party code.

Related: [custom-clients.md](custom-clients.md), [security.md](security.md),
[publishing.md](publishing.md).

## Decision in one paragraph

A custom client is a ZIP containing one `client.json` manifest
(`manifest.json` is accepted as an alias), one entrypoint, source files, and
static assets. A Node/CI/container build service resolves npm
packages at **build time** into a content-addressed cache, compiles
TypeScript/JSX (and Vue SFCs), bundles the reachable graph with esbuild,
tree-shakes and emits an import-free IIFE with Rollup, minifies with esbuild,
validates the resulting JavaScript with Acorn, enforces raw-byte budgets, and
publishes immutable artifacts to R2 plus a build row in Postgres. At runtime the
bundle is loaded in a sandboxed iframe without `allow-same-origin`; all host
capability is reached through a request-id `postMessage` bridge and a strict
CSP. Static analysis is a lint, not the security boundary.

## Questions resolved

### 1. Are the 2.5 MB and 1 MB limits raw or gzip? Do assets count?

**Raw bytes, not gzip.** The limits are bytes of generated JavaScript as
stored/served (UTF-8). A gzip budget is attractive for transfer size, but it is
not a stable proxy for parse/compile cost and cannot be enforced before the
output exists. We can add a separate transfer budget later.

**Assets do not count against either JavaScript budget.** They have their own
per-asset and total caps. The bundle references assets by relative immutable
URL (`./assets/<hash>.<ext>`), so a large image cannot hide inside the JS
budget.

| Item | Default | Counted in 2.5 MB? | Counted in 1 MB? |
|---|---:|---|---|
| uploaded ZIP | 8 MiB | no | no |
| unpacked archive | 16 MiB | no | no |
| source + resolved dependency graph | informational | no | no |
| **unminified esbuild output** | **2.5 MiB** | yes | no |
| **minified final IIFE** | **1 MiB** | no | yes |
| each asset | 5 MiB | no | no |
| all assets | 20 MiB | no | no |

All values live in `DEFAULT_CLIENT_BUDGETS` in
`shared/client-builder/src/constants.ts` and are overridable per build. Tests assert
the exact defaults and both failure paths.

### 2. Is the 2.5 MB limit the uploaded ZIP, unpacked source, or pre-optimization bundle?

It is the **unminified bundle output** (the complete reachable dependency graph
after esbuild bundling, before Rollup/minification). That is the number that
actually measures how much client code the browser must parse and how much
dependency creep a client has accumulated. A separate **unpacked archive cap**
(16 MiB) and **ZIP cap** (8 MiB) keep uploads bounded; the build service also
measures the source/dependency graph for diagnostics, but that number is not a
hard gate because npm packages contain files that are never imported.

The check happens before minification, so a client cannot pass by shipping
minified source in the ZIP.

### 3. Which frameworks now?

- **Vanilla DOM / TypeScript / TSX / React: implemented first.**
- **Vue SFC: implemented first** through `@vue/compiler-sfc` and the framework
  adapter interface.
- **Svelte: adapter interface plus optional compiler path.** It is enabled when
  `svelte/compiler` is installed in the build service; absent compiler is a
  build diagnostic, not a silent failure.
- **Angular: separate builder path, not enabled by the generic adapter.** Angular
  needs its own compiler/CLI and a different entrypoint shape; the adapter
  reports `framework.angular_requires_builder` with guidance. This is deliberate:
  pretending the SFC adapter can compile Angular would produce fragile bundles.

`FrameworkAdapter` is a small interface (`extensions`, `transform`, `validate`)
so adding a framework does not change the archive, package, validation, storage
or runtime layers. The client's framework is declared in `client.json`.

### 4. Reject or strip forbidden APIs?

**Reject, with diagnostics.** The validator reports `file`, `line`, `column`,
`code` and a human-readable message. It never removes live code. The only
"removal" in the pipeline is Rollup/esbuild tree-shaking of provably unused
modules and exports, which is normal bundling and is reported as size data, not
as a security action. Rejection is simpler to audit and prevents a bundle whose
behaviour depends on which analyzer version stripped what.

### 5. Iframe, separate origin, or trusted first-party only?

**Sandboxed iframe without `allow-same-origin`, on a separate origin from the
host page.** Shadow DOM is not a security boundary: it does not isolate
`document`, cookies, storage, navigation or network APIs. A same-origin
alternative cannot provide equivalent isolation without inventing a new process
boundary, so the iframe stays.

The iframe attribute is `sandbox="allow-scripts allow-forms"` by default.
`allow-forms` is present because example clients use forms; `form-action 'none'`
prevents submission/navigation. There is no `allow-same-origin`,
`allow-top-navigation`, `allow-popups`, `allow-downloads` or `allow-modals`.
If a future client truly needs downloads or popups, it is an explicit host
policy change, not a per-client flag.

CSP (see `shared/client-host/src/csp.ts`):

```text
default-src 'none';
script-src 'self';
style-src 'self';
style-src-attr 'none';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'none';
media-src 'none';
object-src 'none';
frame-src 'none';
worker-src 'none';
child-src 'none';
form-action 'none';
base-uri 'none';
manifest-src 'none';
```

The bundle is served from the client-artifact origin, which must differ from
the host page origin. The artifact document includes the CSP in a meta tag and
the Worker serving it must also send it as a response header (including
`frame-ancestors`). Because the iframe is sandboxed without same-origin, its
origin is opaque (`"null"`); the bridge therefore cannot use a meaningful
`targetOrigin`. It uses `postMessage(..., "*")` plus **all** of an exact
`event.source` check, an `event.origin === "null"` check (the opaque sandbox
origin), and a per-mount capability token passed in the URL fragment. That token is not a host secret (the client can read its own frame),
but it prevents unrelated frames from injecting messages.

### 6. How are packages resolved on demand?

**Build-time npm registry fetch + deterministic lockfile + content-addressed
cache.** The client manifest declares dependencies with semver ranges. The build
service:

1. fetches packument metadata from `https://registry.npmjs.org` (configurable);
2. chooses the highest version satisfying each range, hoists it when possible,
   and installs a nested version under `node_modules/.roster/...` when
   transitive ranges conflict (npm-style); a conflicting **direct** dependency
   is a diagnostic;
3. downloads the npm tarball, verifies the registry `integrity` (sha512), and
   stores it under `sha256` in the cache;
4. safely extracts the tar (no symlinks/hardlinks/traversal), rejects native
   addons and packages that need install/build scripts, and records exact
   versions, tarball hashes and integrity in the lockfile.

No lifecycle scripts are ever executed: extraction is a parser, not
`npm install`. `--ignore-scripts` is not enough as a policy statement, so the
builder has no code path that runs a package script at all. Packages declaring
`preinstall`/`install`/`postinstall` or `gypfile` are rejected.

Runtime imports are forbidden. The final bundle is a single IIFE with no
`import`, `import()`, `require` or module loader.

### 7. Where does `getLadder` get a standard MMR projection?

It does not have one yet. Matchmaker storage is arbitrary (`ratings`,
`elo`, nested maps, arrays, anything), so a generic host cannot derive a ladder
from it. `getLadder` requires one of:

- a host-maintained stats projection (the platform records matches and rating
  changes outside arbitrary algorithm storage); or
- a declared matchmaker stats contract (a standard endpoint or storage
  declaration reviewed with the matchmaker).

Until then the host adapter returns
`host.ladder_unavailable` and the client must render a clear "ladder not
available" state. `getRecentMatches` is different: `dsc_match_history` is
host-owned, so it can be wired from `listMatchHistory` now. The adapter maps
participants and the raw result into the client DTO; `mmrDelta` is `0` unless
the host supplies an enrichment function, because history itself does not
contain rating deltas. See `shared/client-host/src/adapters.ts`.

## Trust model

| Party | Trust |
|---|---|
| host page, Worker, DO | trusted |
| build service container | trusted infrastructure, untrusted client input |
| npm registry / package contents | untrusted input; integrity-checked, statically inspected, bundled |
| custom client code | untrusted, including against the host and itself |
| client assets | untrusted bytes served from a dedicated origin |

The client receives only `ClientApi` methods. It never receives contract ids
(only opaque roster handles), wallet handles, database access, raw network
APIs, host cookies, or parent DOM. `confirm()` is executed by the host, not the
iframe, and its UI lives in the host page.

Paid/gas-metered calls are a host policy: `roster.call` is authorized by the
host and should be preceded by `confirm` in the client. The host cannot trust
the client to call `confirm`, so the backend may additionally enforce
confirmation/entitlement at the call boundary.

## Build pipeline

```text
ZIP
 → validate archive (size/files/symlinks/traversal/extensions/one entry/one manifest)
 → extract source + assets
 → read client.json
 → resolve packages (build-time, on demand, cached)
 → framework transform (TS/JSX/esbuild; Vue SFC; optional Svelte)
 → esbuild resolve + bundle to ESM (CJS interop, defines)
 → enforce pre-optimization budget (raw unminified bytes)
 → Rollup facade + tree-shake + IIFE (no imports/exports)
 → esbuild minify
 → enforce final budget (raw bytes)
 → static client validator (Acorn)
 → store source ZIP, lockfile, manifest, bundle, assets
 → publish immutable artifact + DB rows
```

### Why esbuild and Rollup together

esbuild is the transform and dependency bundler: it handles TS/JSX, CJS/ESM
interop, package resolution, browser conditions and defines without a fragile
hand-written CommonJS plugin. Rollup then re-parses the single ESM output,
tree-shakes it once more with an explicit default-only facade, and emits the
IIFE that the iframe loads as a plain script. esbuild minifies the final IIFE.
This keeps the final artifact import-free and avoids a runtime module loader.

### Incremental cache and determinism

- Package tarballs are cached by sha256; lockfile entries carry exact versions,
  integrity and tarball hashes.
- A build ID is derived from source hash + lockfile hash + builder/config hash,
  so the same inputs produce the same artifact URL.
- Output is deterministic: no timestamps in the bundle, no source maps,
  `NODE_ENV=production`, sorted lockfile keys.
- The DB build row is mutable (status/errors), the artifact is immutable. A
  changed build always gets a new ID; stale roster pins keep the old build.

### Isolation

`client-builder` is Node/CI/container code. Native esbuild and Rollup are not
run in the request Worker. The Cloudflare Workflow only coordinates steps and
calls a container/CI build service through an adapter. The container policy is:

- no platform secrets or database credentials in the build container;
- registry/network access only for package fetch (and only the registry host);
- CPU, memory, wall-clock and output-size limits;
- ephemeral filesystem except the content-addressed cache;
- no execution of package lifecycle scripts;
- build input and output are content-hashed.

The repository's tests run the builder in-process with a fake registry/cache;
production wiring is an injected `BuildRunner` / container adapter.

## Storage and lifecycle

Tables (`shared/client-builder/src/schema.ts`):

- `client_build` — status, source/manifest/lockfile/bundle hashes, sizes,
  R2 keys, diagnostics, source ref/commit pin, timestamps, ban fields;
- `client_build_asset` — per-asset path/key/hash/bytes/content type;
- `client_build_package` — exact package pins per build;
- `client_build_usage` — roster → build usage, revoked/banned status;
- `client_build_pin` — roster's explicitly pinned build/source ref (stale-build
  handling).

R2 keys are immutable and include the build ID:

```text
client-builds/<buildId>/source.zip
client-builds/<buildId>/lockfile.json
client-builds/<buildId>/manifest.json
client-builds/<buildId>/bundle.js
client-builds/<buildId>/assets/<sha256>.<ext>
```

`publish` writes assets first, then bundle, then metadata, then marks the row
ready. Any failure deletes every key written by that attempt and marks the row
failed with no artifact keys. Ban/rejection deletes all artifact keys and usage
rows, clears the keys on the row, and keeps only the audit status/reason.

Retention: ready artifacts are retained while referenced by a pin/usage, with
a lifecycle rule for unreferenced builds (default 90 days after the last
record update).
Failed builds have no artifacts to retain. Banned source/zip is deleted by
default; the audit row retains hashes and diagnostics only.

## Diagnostics

Every failure is a `ClientBuildDiagnostic`:

```ts
{ code, message, severity: "error" | "warning", file?, line?, column?, hint? }
```

Examples: `archive.path_traversal`, `archive.symlink`, `archive.too_large`,
`archive.multiple_entrypoints`, `manifest.invalid`, `package.lifecycle_script`,
`package.native_addon`, `package.not_found`, `package.version_conflict`,
`framework.compiler_missing`, `budget.pre_optimization`, `budget.bundle`,
`client.forbidden_api`, `client.dynamic_import`, `client.import_after_bundle`.
The full list and user-facing guidance are in
[docs/client-submission.md](client-submission.md).

## Consequences

- Clients pay a build step and npm download cost; they gain arbitrary browser
  packages.
- Framework support is adapter-bound, not an allowlist of packages.
- The iframe has no same-origin storage/cookies, so clients must keep state in
  host APIs; that is intentional.
- `getLadder` is deliberately unavailable until a projection contract exists;
  this is visible product debt, not a silent generic implementation.
- A future trusted-first-party path could bypass the iframe, but it would need a
  separate review/trust tier and should not weaken the third-party path.
