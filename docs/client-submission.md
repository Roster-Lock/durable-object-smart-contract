# Custom client submission, build and runtime

Status: optional custom-client path. The recommended default is
[schema-clients.md](schema-clients.md), which renders forms from endpoint input
JSON Schemas without executing third-party code.

Related: [custom-clients.md](custom-clients.md),
[client-builds.md](client-builds.md) (ADR), [security.md](security.md).

## Submission format

A submission is one ZIP:

```text
client.json              exactly one, at the archive root
                         (manifest.json is accepted as an alias)
client.tsx               exactly one entrypoint, named by client.json
src/...
assets/logo.svg
assets/style.css
```

Rules enforced before any package is fetched:

| Rule | Limit/default |
|---|---|
| ZIP size | 8 MiB |
| unpacked bytes | 16 MiB |
| files | 512 |
| one file | 5 MiB |
| symlinks | rejected |
| `..`, absolute paths, backslashes | rejected |
| `node_modules/`, `.git/`, `package.json`, `package-lock.json` | rejected |
| `.npmrc`, `.env`, `*.pem`, `*.key`, names containing `secret` | rejected |
| native addons, `.wasm`, nested archives, executables, shell scripts | rejected |
| manifests | exactly one `client.json` |
| entrypoints | exactly one, must exist and be a supported source file |

Source extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.vue`,
`.svelte`. Asset extensions: `.css`, `.json`, `.txt`, images
(`.png/.jpg/.jpeg/.webp/.gif/.svg`) and fonts (`.woff/.woff2/.ttf/.otf`).
`.html` is not a client entrypoint; the client returns a DOM node.

## `client.json`

```json
{
  "schemaVersion": 1,
  "name": "my-client",
  "version": "1.0.0",
  "entry": "client.tsx",
  "framework": "react",
  "description": "optional",
  "jsxImportSource": "react",
  "dependencies": {
    "react": "18.3.1",
    "react-dom": "18.3.1"
  },
  "budgets": {
    "maxPreOptimizationBytes": 2500000,
    "maxBundleBytes": 1000000
  }
}
```

- `framework` is `react`, `vue`, `svelte`, `angular` or `vanilla`.
- `dependencies` values must be semver ranges; `workspace:`, `file:`, git
  URLs and direct tarball URLs are rejected.
- A client may override its budgets **downward** in practice; the host may
  ignore or clamp upward requests. The constants are the source of truth.
- The manifest schema is in
  [`shared/client-builder/schema/client-submission.schema.json`](../shared/client-builder/schema/client-submission.schema.json).

Entrypoint contract:

```ts
import type { ClientApi } from "@roster-lock/smart-contract-sdk";

export default function createClient(api: ClientApi): HTMLElement {
  const root = document.createElement("div");
  return root;
}
```

Only the default export is used. The function may return a Promise of an
`HTMLElement`. The client owns its pages, routing and UI framework.

## Packages and frameworks

Packages are resolved at **build time**, never at runtime:

1. fetch packument metadata from the npm registry;
2. select the highest version satisfying the range, allowing nested versions
   when transitive packages cannot agree (npm-style);
3. download the tarball, verify its registry integrity, cache it by sha256;
4. parse the tarball safely (no symlinks/hardlinks/traversal);
5. reject native addons, WASM, and packages declaring `preinstall`, `install`
   or `postinstall` scripts (scripts are never executed);
6. bundle the reachable graph with esbuild, tree-shake and emit an import-free
   IIFE with Rollup, then minify with esbuild.

The build service never shells out to `npm install`; it extracts only the
tarballs it fetched. Any surrounding tooling that does invoke npm must pass
`--ignore-scripts`. Lifecycle-script packages are rejected rather than merely
skipped.

Type-only packages (for example `csstype`) are allowed without a runtime
entry; esbuild erases their imports.

### Framework support

| Framework | Status |
|---|---|
| vanilla DOM / TS / JS | supported |
| React / TSX / JSX | supported; automatic JSX runtime |
| Vue SFC | supported through `@vue/compiler-sfc` (script setup, templates, scoped styles) |
| Svelte | adapter path; requires `svelte/compiler` in the build service |
| Angular | needs a dedicated Angular builder path; the generic adapter returns `framework.angular_requires_builder` |

Framework adapters only rewrite source to JavaScript. The archive, package,
bundling, validation, storage and runtime layers never assume React.

### CSP-safe validation libraries

Some UI/schema libraries use AJV runtime code generation (`new Function`) and
cannot work under `script-src 'self'` without `'unsafe-eval'`. The
living-roster example uses RJSF with `createCspSafeValidator()` from
`@roster-lock/smart-contract-sdk/rjsf`, backed by `@cfworker/json-schema`. The build
rejects `new Function`/`eval`, so a client using the stock AJV validator fails
with `client.function_constructor`.

The build has one narrow library compatibility shim: lodash's legacy
`Function('return this')` fallback in `_root.js` is replaced with
`globalThis`/`self` detection. That branch is dead in a browser frame; it is
not a general code-removal pass.

## Size budgets

**All budgets are raw bytes, not gzip.** The final bundle budget is minified
JavaScript bytes. Assets are not included in either JavaScript budget.

| Item | Default |
|---|---|
| uploaded ZIP | 8 MiB |
| unpacked archive | 16 MiB |
| **pre-optimization bundle** (unminified esbuild output) | **2.5 MB** (2,500,000 bytes) |
| **final bundle** (minified Rollup IIFE) | **1 MB** (1,000,000 bytes) |
| one asset | 5 MiB |
| all assets | 20 MiB |

The 2.5 MB limit is the unminified dependency graph, not the uploaded ZIP and
not the unpacked archive. The final 1 MB limit is checked before storage. Both
are enforced by tests in `shared/client-builder/test/client-build.test.ts`; constants live in
`shared/client-builder/src/constants.ts`.

CSS imports are extracted to artifact-level stylesheets linked by the client
document. Asset imports resolve to relative `./assets/<hash>.<ext>` URLs. A
large asset does not consume the JavaScript budget, but it is still capped.

## Security model

The build-time analyzer is a lint, not the security boundary.

Final JavaScript is parsed with Acorn and rejected with diagnostics for:

- network: `fetch`, `XMLHttpRequest`, `WebSocket`, `WebSocketStream`,
  `EventSource`, `WebTransport`, `RTCPeerConnection`, `navigator.sendBeacon`,
  service workers;
- code loading: `eval`, `Function` construction, `importScripts`, `new Worker`,
  `new SharedWorker`, dynamic `import()`, `require`;
- DOM escape hatches: dynamic `<script>` creation, `document.write`,
  `javascript:` URLs, `srcdoc`, `innerHTML`/`outerHTML`/`insertAdjacentHTML`
  in authored sources;
- the parent page: `window.parent`/`window.top`, `parent.document`,
  `document.cookie`, origin storage, raw `postMessage`;
- imports or exports after bundling.

Authored sources are checked strictly. The final bundle permits `innerHTML` /
`outerHTML` assignments from npm libraries (React and Vue renderers use them)
because CSP blocks inline script, and the authored-source check already rejects
them in client code. This is the only `innerHTML` allowance; the lodash
`Function('return this')` global-detection fallback is replaced with
`globalThis`/`self` and the replacement is reported in build warnings. `eval`,
`Function`, dynamic script, network and worker APIs remain rejected everywhere.

The runtime boundary is a sandboxed iframe with
`sandbox="allow-scripts allow-forms"` and **no** `allow-same-origin`, served
from a separate origin with CSP:

```text
default-src 'none'; script-src 'self'; style-src 'self';
style-src-attr 'none'; img-src 'self' data: blob:;
font-src 'self'; connect-src 'none'; media-src 'none';
object-src 'none'; frame-src 'none'; worker-src 'none'; child-src 'none';
form-action 'none'; base-uri 'none'; manifest-src 'none';
navigate-to 'none'
```

The artifact document is static: bundle and runtime are ordinary script tags,
so there is no runtime module loader and no dynamic script injection. Bundle
`shared/client-host/src/runtime-entry.ts` once and serve it as `runtimeScriptUrl`;
the client bundle defines `__rosterClientFactory` and is loaded separately. Because
the iframe has an opaque origin, `postMessage` uses `targetOrigin: "*"` plus an
exact `event.source` check, an `event.origin === "null"` check and a per-mount
token in the URL fragment. The token
is not a host secret; it prevents unrelated frames from injecting messages.

No host function, DOM node, contract id, wallet handle, cookie, database handle
or raw network API crosses the bridge. Client code sees only serializable
`ClientApi` values and host-owned `confirm()`.

## Runtime integration

The host creates an iframe pointing at the immutable artifact document. The
repository tests the bridge, confirmation, resize and frame policy with a
deterministic fake window/iframe; Playwright is not a dependency of this
workspace.

```ts
import { ClientFrameHost } from "@roster-lock/smart-contract-client-host";

const frame = new ClientFrameHost({
  iframe,
  window,
  api: host,                 // ClientHost implementation
  confirm,                   // host-owned UI
  documentUrl: `https://client-artifacts.example/client-builds/${buildId}/index.html`,
  expectedBuild: { buildId },
  onResize: (height) => { /* iframe height follows the client */ },
});
await frame.start();
```

The serving layer must send the CSP as a response header too (including
`frame-ancestors <host origin>`); `createClientFrameHeaders()` returns the
header set. The document body is generated by `createClientDocument()` and
served from the client-artifact origin.

The artifact layout is immutable and build-scoped:

```text
client-builds/<buildId>/source.zip
client-builds/<buildId>/lockfile.json
client-builds/<buildId>/manifest.json
client-builds/<buildId>/bundle.js
client-builds/<buildId>/assets/<sha256>.<ext>
client-builds/<buildId>/index.html   (when the serving layer stores it)
```

`publishClientBuild` accepts optional `documentHtml`; if it is omitted, the
artifact/serving layer must generate the document with
`createClientDocument()` from the same manifest and serve it from the
client-artifact origin. The CSP and `frame-ancestors` header still apply.

### Stale builds and pinning

A build ID is derived from source hash + lockfile hash + bundle hash + builder
and budget config. The artifact URL never changes for the same inputs. A roster
pins an exact build (`client_build_pin`); publishing a new source creates a new
build and does not move existing pins. The runtime checks that the document URL
contains the pinned build ID before loading it.

### Host API, match history and ladders

`getRecentMatches` is wired from host-owned `dsc_match_history` in
`@roster-lock/match-making-cloudflare`:

```ts
const recentMatches = createRecentMatchesSource({
  openDb,
  rosterId,
  mmrDelta: ({ matchId, userId }) => stats.mmrDelta(matchId, userId),
});
```

`getLadder` has **no generic implementation**. Matchmaker storage is arbitrary
(`ratings`, `elo`, nested maps, arrays, anything), so a host cannot derive a
standard ladder from it. It requires either a host-maintained stats projection
or a declared matchmaker stats contract. Until one exists, the host adapter
returns `host.ladder_unavailable`, and clients should render an explicit
unavailable state. This is deliberate product debt, not a hidden generic
implementation.

## Build failure diagnostics

Every failure is reported as diagnostics with `code`, `message`, `severity`
and, where possible, `file`, `line`, `column` and a `hint`.

| Code | Meaning |
|---|---|
| `archive.too_large`, `archive.unpacked_too_large`, `archive.too_many_files`, `archive.file_too_large` | ZIP limits |
| `archive.path_traversal`, `archive.symlink`, `archive.duplicate` | unsafe archive shape |
| `archive.missing_manifest`, `archive.multiple_manifests` | manifest count |
| `archive.entry_missing`, `archive.entry_extension` | entrypoint |
| `archive.build_scripts`, `archive.forbidden_file`, `archive.node_modules` | forbidden files |
| `archive.extension` | file type not allowed |
| `manifest.*` | `client.json` field/schema errors |
| `package.not_found`, `package.no_matching_version`, `package.version_conflict` | resolution |
| `package.lifecycle_script`, `package.native_addon`, `package.wasm` | browser/script safety |
| `package.integrity` | registry hash mismatch |
| `package.tarball_too_large`, `package.unpacked_too_large` | package limits |
| `framework.compiler_missing`, `framework.angular_requires_builder` | framework support |
| `budget.pre_optimization` | unminified bundle over 2.5 MB |
| `budget.bundle` | final bundle over 1 MB |
| `budget.asset`, `budget.assets_total` | asset limits |
| `client.forbidden_api`, `client.dynamic_import`, `client.import_after_bundle`, `client.export_after_bundle` | final lint |
| `client.dynamic_script`, `client.inner_html`, `client.srcdoc`, `client.javascript_url` | DOM escape hatches in authored source |
| `client.parent_dom`, `client.cookie` | parent-page/cookie access |
| `build.isolation`, `build.isolation_secrets`, `build.lifecycle_scripts` | build service policy |
| `publish.failed` | artifact/DB publication failure (partial artifacts deleted) |

Failed builds have no artifact keys. Banning a build deletes its bundle,
assets, source, lockfile, manifest and document, removes usage rows, and keeps
only the audit row (hashes, diagnostics, reason).

## Build service isolation

Native esbuild/Rollup are not run in the request Worker. A Cloudflare Workflow
coordinates steps and calls an isolated container/CI build service. The
container policy:

- no platform secrets or database credentials;
- registry/network access only for package fetch;
- CPU, memory and wall-clock limits;
- ephemeral filesystem except the content-addressed package cache;
- no package lifecycle scripts;
- deterministic lockfile and content hashes.

`assertBuildIsolation()` rejects `mode: "worker"`, secrets, or lifecycle
script execution. In a Cloudflare Workflow, adapt `step.do` with
`cloudflareWorkflowStep(step)` and have the build step call the container
service; only manifest/status data should cross durable step boundaries.

## Running the examples

The example manifests are
[`examples/matchmaker-pool/client.json`](../examples/matchmaker-pool/client.json)
and
[`examples/living-roster/client.json`](../examples/living-roster/client.json).
The integration tests build both from the source files and assert the default
budgets:

```bash
npx vitest run examples/test/client-examples.test.ts
```

The examples resolve `@roster-lock/smart-contract-sdk` from the workspace in tests; a
production build service must publish that SDK or provide it as a trusted
workspace package. The living-roster example uses React and RJSF internally,
but still returns a plain DOM node; the runtime does not know or care which
framework produced it.
