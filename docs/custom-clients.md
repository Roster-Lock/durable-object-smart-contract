# Custom clients (optional tier)

Status: optional/experimental. The recommended default is a schema-driven client
generated from endpoint input JSON Schemas; see
[schema-clients.md](schema-clients.md). Keep this path for the rare workflow
that genuinely needs a bespoke UI, not as the primary client plan.

A custom client is a function that receives host capabilities and returns a DOM
node. The client owns its pages, framework and UI. The platform only mounts the
returned node and exposes the host bridge.

```ts
import type { ClientApi } from "@roster-lock/smart-contract-sdk";

export default function createClient(api: ClientApi): HTMLElement {
  const root = document.createElement("div");
  // Build pages, forms and displays here.
  return root;
}
```

Clients live with their example algorithm:

```text
examples/
  matchmaker-pool/
    matchmaker.ts
    client.tsx
  living-roster/
    contract.js
    client.tsx
```

## Host API

```ts
interface ClientApi {
  session: { userId?: string; displayName?: string };
  matchmaker: {
    getPlayer(userId: string): Promise<PlayerStats>;
    getLadder(input?: { limit?: number; cursor?: string }): Promise<Page<LadderEntry>>;
    getRecentMatches(userId: string, limit?: number): Promise<RecentMatch[]>;
  };
  roster: {
    listContracts(): Promise<RosterContract[]>;
    getContract(handle: string): Promise<RosterContract | undefined>;
    getStorage(handle: string): Promise<Record<string, unknown>>;
    call(handle: string, endpoint: string, input?: JsonValue): Promise<JsonValue>;
  };
  catalog: {
    getPiece(id: string): Promise<Piece | undefined>;
    searchPieces(query: string, limit?: number): Promise<Piece[]>;
    getUser(id: string): Promise<UserSummary | undefined>;
    searchUsers(query: string, limit?: number): Promise<UserSummary[]>;
  };
  confirm(input: { title: string; message: string; details?: JsonValue }): Promise<boolean>;
}
```

The API has no contract ids, wallet, database handle, `fetch`, `WebSocket` or
`eval`. `confirm` is host-owned and should be used before paid/gas-metered
calls. `getLadder` requires a standard host stats projection or a declared
matchmaker stats contract; matchmaker storage is arbitrary. `getRecentMatches`
is backed by `dsc_match_history`.

## DOM library

`@roster-lock/smart-contract-sdk` exports framework-free helpers:

```ts
const piece = createPieceInput({ catalog: api.catalog, onChange: (id) => … });
root.append(piece.element);

const pieceView = createPieceDisplay({ catalog: api.catalog, pieceId: "p1" });
const user = createUserInput({ catalog: api.catalog });
const userView = createUserDisplay({ catalog: api.catalog, userId: "u1" });
```

Inputs expose `element`, `getValue()`, `setValue()` and `destroy()`. The
display/input controls use the catalog host, so they never fetch external data
themselves. Images and links come from catalog metadata and are governed by the
host CSP.

## Matchmaking example

`examples/matchmaker-pool/client.tsx` is a DOM client:

- shows the current user's MMR, rank and match count;
- shows the most recent match;
- renders a table sorted by MMR;
- clicking a row shows that player's ranking.

A React client can use the same API; the platform does not care which framework
produced the DOM node.

## Living-roster example

`examples/living-roster/client.tsx` uses React and RJSF internally, but only
exports the required factory:

```tsx
export default function createClient(api: ClientApi): HTMLElement {
  const root = document.createElement("div");
  createRoot(root).render(<LivingRosterApp api={api} />);
  return root;
}
```

It demonstrates proposals, vote state, yes/no vote forms, resolution, the
roster, and custom piece/user fields. Another client can use vanilla DOM, RJSF,
or a different framework; only the returned DOM node is required.

## Match history

Match history is host-owned and independent of the matchmaker's storage. It
records participants, finish time and the raw result, and indexes participants
so a user's matches can be queried efficiently. `getRecentMatches` is the
client-facing view.

## Security model

- The client runs in a sandboxed iframe with a strict CSP; the host bridge is
  the only RPC surface.
- `fetch`, `WebSocket`, `XMLHttpRequest`, `EventSource`, `eval`, `Function`,
  workers, importScripts and similar escape hatches are unavailable in the
  runtime. Static analysis is a lint on top of that, not the security boundary.
- Imports such as `react`, `react-dom` and `@rjsf/*` are allowed and bundled.
  Packages are fetched at build time, integrity-checked, cached and bundled;
  runtime imports and network access are forbidden. For RJSF, use
  `createCspSafeValidator()` from `@roster-lock/smart-contract-sdk/rjsf`; AJV's stock
  validator uses runtime `Function` code generation and is rejected.
- The host controls endpoint authorization and gas/wallet charging.

The iframe runtime, client bundle builder and client validator are implemented
in `shared/client-host/` and `shared/client-builder/`. See
[client-builds.md](client-builds.md) for the ADR and
[client-submission.md](client-submission.md) for the submission format,
package/framework rules, size budgets, security model and diagnostics.

`getLadder` needs a host-maintained stats projection or a declared matchmaker
stats contract because matchmaker storage is arbitrary; `getRecentMatches` is
wired from `dsc_match_history`. See
[client-submission.md](client-submission.md#host-api-match-history-and-ladders).
