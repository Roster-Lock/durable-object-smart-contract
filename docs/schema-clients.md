# Schema-driven clients

Status: recommended default. Custom clients remain available as an optional,
higher-trust tier; see [custom-clients.md](custom-clients.md).

A contract already publishes a JSON Schema for every endpoint's input. That is
enough information to render a usable form: labels, help text, required fields,
enums, numbers, booleans and nested objects are all in the manifest. The
platform can therefore build the client **without executing contract-supplied
code**.

```text
contract manifest
  endpoints.propose.input = {
    type: "object",
    title: "Propose a change",
    description: "Add a piece through a vote",
    required: ["pieceId"],
    properties: {
      pieceId: { type: "string", title: "Piece", "x-roster-input": "piece" },
      note: { type: "string", "x-roster-ui": { widget: "textarea" } }
    }
  }
        │
        ▼
@roster-lock/living-roster-client
  endpoint list + RJSF form + host call + result
```

## Why this is the better default

- **No untrusted JavaScript.** No iframe, bundle builder, package cache or
  third-party framework code is needed for the normal client path. The host
  renders forms from data.
- **The manifest is already the contract.** Authors do not maintain a second UI
  implementation, build pipeline or lockfile.
- **The host owns confirmation, authorization, gas and errors.** Mutating calls
  still go through the host-owned `confirm` and `roster.call`.
- **UI annotations are data.** JSON Schema `title` / `description` and a small
  allowlist of `x-roster-*` hints cover most forms. Raw RJSF `uiSchema` is not
  accepted from contracts.

## Usage

```tsx
import { ClientHostProvider } from "@roster-lock/smart-contract-sdk/react";
import { SchemaRosterClient } from "@roster-lock/living-roster-client";

createRoot(root).render(
  <ClientHostProvider host={api}>
    <SchemaRosterClient contractHandle="living-roster" />
  </ClientHostProvider>,
);
```

Or render one contract directly:

```tsx
import { SchemaContractClient } from "@roster-lock/living-roster-client";

<SchemaContractClient contract={contract} />
```

The component:

1. filters endpoints to `public` / `human` (never `contract` / `roster-lock`);
2. renders an RJSF form from `endpoint.input`;
3. shows `title` / `description` from the endpoint and schema;
4. confirms before any call (all contract calls are gas-metered);
5. calls `host.roster.call(handle, endpoint, formData)`;
6. renders the result as text (`JSON.stringify`, never `innerHTML`).

`buildEndpointFormModels(contract)` is the pure model layer and is tested
without a DOM.

## Example in this repo

The living-roster contract adds a fetchable read-only source and a schema-driven
inspection endpoint:

```js
// examples/living-roster/contract.js
roster: {
  access: "public",
  mutates: false,
  run: async function (_input, ctx) {
    return await readRoster(ctx);
  },
},

inspectPiece: {
  access: "public",
  mutates: false,
  input: {
    type: "object",
    title: "Inspect a roster piece",
    required: ["pieceId"],
    properties: {
      pieceId: {
        type: "string",
        "x-roster-list": {
          type: "piece",
          include: [{ handle: "living-roster", endpoint: "roster" }]
        }
      }
    }
  },
  run: async function (input, ctx) {
    var roster = await readRoster(ctx);
    return { pieceId: String(input.pieceId), onRoster: roster.indexOf(String(input.pieceId)) !== -1 };
  }
}
```

The host-side example is
[`examples/living-roster/schema-client.tsx`](../examples/living-roster/schema-client.tsx);
it renders `SchemaRosterClient` for the contract. The existing custom client
[`examples/living-roster/client.tsx`](../examples/living-roster/client.tsx)
remains as the optional bespoke-UI tier.

## Author annotations

| Annotation | Effect |
|---|---|
| `title` | endpoint / field label |
| `description` | endpoint / field help |
| `default` | initial form value |
| `examples` | input examples (RJSF) |
| `format` | standard widgets (`email`, `uri`, `date`, …) |
| `"x-roster-input": "piece"` or `"user"` | catalog-backed picker |
| `format: "piece-id"` / `"user-id"` | same, compatibility form |
| `"x-roster-ui": { "widget": "textarea" }` | allowlisted widget |
| `"x-roster-ui": { "placeholder": "…", "help": "…" }` | field hints |
| `"x-roster-placeholder"`, `"x-roster-help"` | shorthand hints |
| `"x-roster-order": ["a", "b"]` | field order |
| `"x-roster-list": { "type": "piece" }` | any catalog piece |
| `"x-roster-list": { "type": "user", "exclude": [...] }` | any catalog user except source values |
| `"x-roster-list": { "type": "piece", "include": [...] }` | only values returned by include sources |
| `"x-roster-list": { "type": "labeled-value", "include": [...] }` | fetchable `{value,label}` options |

Allowed widgets: `text`, `textarea`, `select`, `radio`, `checkbox`,
`checkboxes`, `range`, `password`, `email`, `uri`, `date`, `datetime`, `time`,
`color`.

### List sources

A property may declare where its allowed values come from:

```json
{
  "pieceId": {
    "type": "string",
    "title": "Piece",
    "description": "Only pieces currently available for this roster.",
    "x-roster-list": {
      "type": "piece",
      "include": [
        { "handle": "living-roster", "endpoint": "listAvailablePieces" }
      ],
      "exclude": [
        { "handle": "moderation", "endpoint": "blockedPieces" }
      ]
    }
  },
  "mode": {
    "type": "string",
    "title": "Mode",
    "x-roster-list": {
      "type": "labeled-value",
      "include": [
        { "handle": "modes", "endpoint": "listModes" }
      ]
    }
  }
}
```

```ts
type FetchableSource = { handle: string; endpoint: string };

type XRosterListConfig = {
  type: "piece" | "user";
  include?: FetchableSource[]; // absent means all catalog items
  exclude?: FetchableSource[]; // applied last; exclude wins
};

type XFetchableListConfig = {
  type: "labeled-value";
  include: FetchableSource[]; // at least one
  exclude?: FetchableSource[];
};
```

For now a fetchable source is called with no arguments; it must be a `public`
or `human` endpoint that declares `mutates: false`.

`piece` / `user`:

- With no `include`, every catalog piece/user is allowed. The field uses the
  existing catalog search.
- With `include`, the union of the include sources is allowed.
- `exclude` sources are subtracted last, so an ID in both include and exclude
  is excluded.

`labeled-value`:

- At least one `include` source is required.
- Every **include** item must be `{ "value": string, "label": string }`.
- `exclude` sources only need values (strings or `{ value }` items) and are
  subtracted last.

Source results may be a direct array or `{ "items": [...] }` / `{ "values": [...] }`.
Sources are fetched through `roster.getContract` + `roster.call`, validated as
read-only/public, and cached per host for the page. Fetches do not show the
form confirmation because they are list reads; the host should still authorize
and cache them.

The field is select/search-only and currently targets scalar string properties.
`x-roster-source` is accepted as an alias for `x-roster-list`.

`x-roster-list` is a UI/source hint, not an authorization boundary. If
membership affects contract invariants, the endpoint must still validate it.
Because the source endpoint itself is read-only, it can return values that
depend on the caller or current state without mutating the contract.

## Security notes

- RJSF's stock AJV validator uses runtime `Function` code generation. The
  schema client uses `createCspSafeValidator()` from
  `@roster-lock/smart-contract-sdk/rjsf`, backed by `@cfworker/json-schema`.
- The contract author controls schema data, not the React component tree. The
  host maps only known `x-roster-*` hints; unknown hints and raw `uiSchema` are
  ignored.
- The host still enforces endpoint access, gas/wallet charging, input schema
  validation before escrow, and confirmation. The generated client confirms
  form submissions, including read-only ones, because contract calls are
  gas-metered. List-source fetches are host-authorized read-only calls and are
  cached; they are not form submissions. Client UI is not an authorization
  boundary.
- If the host page uses a strict CSP, it should not need `'unsafe-eval'`;
  `createCspSafeValidator` is plain JavaScript.

## What JSON Schema does not describe

JSON Schema describes an endpoint's input, not:

- multi-step workflows (proposal → vote → resolve);
- rich read models (rankings, match history, roster presentation);
- navigation between pages;
- custom result rendering, charts, drag-and-drop, or game-specific widgets.

For those, the platform can add **host-owned views**: a ranking page, a roster
tree, a match history page, or a curated component for a known contract shape.
Those are platform code with a normal review process, not arbitrary contract
code.

If an author truly needs a bespoke UI, the optional custom-client path
(iframe + build service) remains available, but it should be an explicit
higher-trust tier rather than the default. This repository keeps that path
implemented and documented in [client-builds.md](client-builds.md) and
[custom-clients.md](custom-clients.md).

## Migration

- Keep the manifest input schemas; no contract changes are required.
- Add `title` / `description` / `x-roster-*` hints to endpoint input schemas
  where the generated form is too plain.
- Replace examples' hand-written forms with `SchemaContractClient` when the
  form is purely schema-shaped.
- Do not remove the custom-client builder/runtime until the schema-driven path
  has covered the workflows that actually need bespoke UI; it is now optional,
  not the primary plan.
