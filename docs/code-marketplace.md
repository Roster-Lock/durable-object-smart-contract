# Communal code marketplace

Status: the discovery/build pipeline and the `share-approved` workflow are
implemented. Approval lives in `shared/review`
([reviewed-versions.md](reviewed-versions.md)); discovery derives approved and
banned state from the linked review record, and production deploy routes must
require an approved version.

GitHub holds the code and discussion; the platform holds pinned selections,
execution and the official stamp. The lightweight path avoids building a full
marketplace UI at first:

- one repo per **matchmaker**;
- one repo per **living-roster environment**, containing one or more contracts
  and a deploy script;
- GitHub issues/discussions/reactions for comments and votes;
- a pinned commit stored per roster;
- the owner runs the environment's deploy script from their machine or CI.

The platform does not run the deploy script; it runs the contracts and
matchmakers. That keeps arbitrary deploy orchestration out of the platform and
makes the environment repo the owner's unit of control.

## Repository shapes

Matchmaker:

```text
matchmaker-elo/
  matchmaker.js       # defineMatchmaker(...)
  tests/
  fixtures/
  README.md
  LICENSE
```

Living-roster environment:

```text
living-roster-env/
  contracts/
    governance.js
    ladder.js
  deploy.ts           # owner-run; not executed by the platform
  roster.json         # optional declarative config
  tests/
  fixtures/
  README.md
  LICENSE
```

The environment is the unit of selection and pinning, not each contract. A
roster can contain multiple contracts; they share the roster id and are
recorded together in the deployment manifest.

The contract files are QuickJS sources. The deploy script can be TypeScript or
Node because the owner runs it, not the sandbox.

## Pinning and source of truth

An environment item points at:

```json
{
  "kind": "roster-environment",
  "repo": "github.com/example/living-roster-env",
  "commit": "9f3c...",
  "contracts": ["contracts/governance.js", "contracts/ladder.js"],
  "deploy": "deploy.ts",
  "license": "MIT",
  "version": "1.2.0"
}
```

A matchmaker item points at its entry file:

```json
{
  "kind": "matchmaker",
  "repo": "github.com/example/matchmaker-elo",
  "commit": "9f3c...",
  "entry": "matchmaker.js",
  "license": "MIT",
  "version": "1.0.0"
}
```

- The **commit is pinned**, never a branch. A push cannot change what a roster
  runs.
- The platform fetches the commit, verifies each source hash, analyzes the
  contracts, and stores an immutable copy. GitHub can disappear; the pinned
  source still runs.
- No module loader in the contract runtime: each contract file is
  self-contained. The deploy script can use Node packages because it runs
  outside the platform.
- A branch/tag is for browsing; selection resolves to a commit SHA.

## Deploy script

Recommended: **owner-run**, using a scoped deploy token and the platform
SDK/API.

```ts
// deploy.ts — runs on the owner's machine or in GitHub Actions
const governance = await client.deploy({
  rosterId,
  name: "governance",
  source: readFile("contracts/governance.js"),
  initArgs: { ... },
});

const ladder = await client.deploy({
  rosterId,
  name: "ladder",
  source: readFile("contracts/ladder.js"),
  initArgs: { governance: governance.contractId },
});

await client.recordDeployment({
  environment: "github.com/example/living-roster-env@9f3c...",
  contracts: { governance, ladder },
});
```

Why owner-run:

- no arbitrary deploy script execution on the platform;
- the script can be TypeScript/Node and use normal tooling;
- the owner controls ordering, migrations and retries;
- the platform still analyzes every contract source and enforces schema guards;
- GitHub Actions can run it with a scoped token for repeatable deploys.

The platform records the environment repo/commit, deployment id, contract ids
and source hashes. The deploy script should be idempotent: re-running it should
detect existing contracts and either update them or no-op. Multi-contract
deployment is **not atomic**; deploy new contracts first, verify, then switch
the roster's active deployment. The platform must not pretend a failed run
rolled everything back.

A platform-run deploy script (one-click deploy) can come later with a sandboxed
host API and a plan/approve step. It is not needed for the lightweight path.

## Contracts versus matchmakers

A matchmaker is selected and switched: switching resets its queue/ratings while
the roster contracts and their state stay.

A living-roster contract is deployed: its code and storage schema are fixed for
that instance. An environment update does not upgrade live contracts by itself;
the deploy script creates/updates contracts and handles migrations. The
environment listing needs:

- each contract's storage schema and `version`;
- migration notes and idempotency expectations;
- required `initArgs`;
- test fixtures.

The marketplace can show a diff and a migration checklist, but the owner
decides when to deploy.

## Lightweight registry

Use GitHub as the discovery layer:

- one topic per kind, for example `roster-lock-matchmaker` and
  `roster-lock-roster`;
- or a small index repo with a `registry.json`;
- issues/discussions for comments, PRs for revisions;
- reactions as the informal up/down signal;
- a release/tag or registry flag for the official stamp.

The platform stores only the roster's pins:

```text
roster.environment = repo + commit
roster.matchmaker  = repo + commit
```

A simple roster settings page can show the current pins and let the owner change
them. The platform fetches the repo, verifies the commit and license, analyzes
the code, and caches an immutable copy. No webhook-driven auto-deploy.

The official stamp is the platform's review of a specific commit. Community
items are self-serve; the roster owner accepts the risk.

## Workflow

```text
GitHub repo / commit
        │
        ▼
roster settings: pin environment + matchmaker commits
        │
        ├── environment: owner runs deploy.ts, records deployment
        └── matchmaker: platform selects the pinned source
```

- Comments/votes live on GitHub; the platform does not duplicate them.
- Official review checks code, license, fixtures, security and capabilities.
- A new commit requires a new pin; nothing auto-updates.
- The platform can delist malicious code and disable a running matchmaker; a
  deployed contract remains sandboxed and isolated.

## What GitHub does not solve

GitHub handles source, issues, PRs and releases. It does not replace:

- the QuickJS sandbox and resource limits;
- static analysis and the fixture runner;
- official review and security response;
- roster pinning/approval;
- contract state migration;
- moderation and delisting;
- matchmaking subscriptions/revenue.

The owner-run deploy script reduces platform work, but the platform still owns
the runtime and the trust boundary.

## Minimal integration

1. GitHub link/fetch by repo + commit (public repos first; GitHub App later).
2. Verify license and each contract/matchmaker source hash.
3. Analyze contracts and run tests/fixtures.
4. Store the roster's environment and matchmaker pins.
5. For environments, let the owner-run deploy script call the existing deploy
   API, and record the resulting deployment manifest.
6. For matchmakers, select the pinned source in the runner.

No marketplace database or full UI is required for the first version; GitHub
plus a roster settings page is enough.
