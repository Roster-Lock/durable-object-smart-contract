# Reviewed versions / deployment allowlist

Status: implemented in `shared/review/` and wired into the marketplace.

Living-roster environments and matchmakers are both executable code. The
platform's policy is **fail closed**: a version may be deployed or adopted only
after that exact immutable artifact has been reviewed and approved. The
marketplace's discovery catalog remains the place where repositories are
proposed and builds happen; this package is the authoritative allowlist that
the deploy and adoption paths consult.

## Why a separate package

- It is a **policy and audit** concern, not a runtime, build or marketplace
  concern.
- Both living-roster and matchmaker deploys use the same gate.
- The platform can replace GitHub discovery, add another source, or run reviews
  manually without changing the allowlist model.
- The gate has no dependency on Hono, GitHub, R2, QuickJS or the web UI.
- It lives under `shared/` because both products enforce it, but it depends only
  on the engine's `Db`.

## Review identity

A review is keyed by `(kind, sourceHash)`:

- `kind`: `"roster-environment"` (a living-roster environment; `"living-roster"`
  is accepted as an input alias) or `"matchmaker"`.
- `sourceHash`: the exact code/artifact hash produced by the build. For
  contract/matchmaker source strings `hashReviewedSource(source)` produces the
  same SHA-256 hex digest as the runtime (no `sha256:` prefix). Any source change
  produces a new hash and therefore a new review.

The id is deterministic (`rv_` plus a stable hash of kind + source hash), so
re-submitting the same artifact returns the existing row. The unique database
key is `(kind, source_hash)`; the id is only an ergonomic handle. Submission
never resets an existing decision.

## Statuses

```text
pending ──approve──▶ approved ──ban/delist──▶ banned
   │                    │
   └──reject──▶ rejected│
                  │     │
                  └─approve (re-review)
```

| Status | Deployable? |
|---|---|
| `pending` | no |
| `approved` | yes |
| `rejected` | no |
| `banned` | no; also blocks re-submission of the same hash |

`reject` is for pending/rejected reviews. An approved version is revoked with
`ban`/`delist`, not `reject`. Ban wins over every other status.

## Usage

```ts
import {
  PostgresReviewedVersionRepository,
  ReviewedVersionService,
} from "@roster-lock/reviewed-versions";

const reviews = new ReviewedVersionService({
  repository: new PostgresReviewedVersionRepository(db),
});

// A build/CI or discovery step submits the exact artifact hash.
const pending = await reviews.submit({
  kind: "roster-environment",
  sourceHash: builtArtifact.sourceHash,
  version: builtArtifact.version,
  repoUrl: "github.com/example/living-roster-env",
  commit: "9f3c...",
  entry: "contracts/governance.js",
});

// An authorized reviewer makes the decision.
await reviews.approve(pending.id, adminUserId, "reviewed and tested");

// Every deploy gate does this before calling the runtime deploy:
const approved = await reviews.requireApproved({
  kind: "roster-environment",
  sourceHash: builtArtifact.sourceHash,
});
await contractService.deploy({ /* ... */ });

// Or keep the gate and deploy in one call. For a contract source, this
// computes the same SHA-256 hash as the runtime before checking:
await deployReviewedSource(
  reviews,
  { kind: "roster-environment", source: contractSource },
  async (version, sourceHash) => contractService.deploy({ /* ... */ }),
);

// If the hash is already known from the build artifact:
await deployReviewedVersion(
  reviews,
  { kind: "roster-environment", sourceHash: builtArtifact.sourceHash },
  async () => contractService.deploy({ /* ... */ }),
);
```

`requireApproved` throws a `ReviewError` with one of:

- `review.missing`
- `review.pending`
- `review.rejected`
- `review.banned`

The host should map these to a refusal to deploy, not a retry or a warning.

## Integrating with the runtime

The engine's deploy service does not know about reviews. Production routes must
call the gate **before** `ContractService.deploy` or the matchmaker deployment
service. The product adopters do this for you:

```ts
const adopter = createLivingRosterAdopter({
  gate: reviews,
  store: adoptionStore,
  deploy: async (request, version) => deployEnvironment(version, request),
});
await adopter.adopt({
  rosterId,
  kind: "living-roster",
  sourceHash: build.sourceHash,
  repo,
  commit,
  entry,
});
```

Use `createMatchMakerAdopter` / `kind: "match-maker"` for matchmakers. Both
wrappers check the exact hash before running the deploy/attach effect and record
the adoption so it can be revoked.

Use `kind: "matchmaker"` for matchmaker deployments. A roster should pin the
approved source hash, not a mutable branch or repository URL.

## Relationship to discovery

Discovery no longer stores its own approval state. `discovery_commit` has a
`reviewed_version_id`, and `getCommit` left-joins `reviewed_version` to derive
`approved`/`banned`. The marketplace app composes the two:

```text
repo/commit → build → artifact + sourceHash
                         │
                         ├─ review.submit → review.approve → link commit
                         │
                         └─ product adopter.adopt (gate checks the hash)
                                      │
                                discovery.recordUsage

ban: review.ban → product revoke → discovery.disableCommit → notify
```

`@roster-lock/share-approved` owns that flow:

1. `approveCommit` builds the commit, submits/approves the review, links it and
   notifies rosters.
2. `adoptCommit` builds, asks the product adopter to adopt (which enforces the
   gate), and records the usage projection.
3. `banCommit` bans the review, revokes the adopted version, removes the
   artifact, optionally clears roster data and notifies.

The review package intentionally does not import discovery or the products.
Discovery imports review for its migration and status join; the products import
review for the gate; `share-approved` is the only package that imports all of
them.

## Storage

Table `reviewed_version`:

```text
id, kind, source_hash, status,
version, repo_url, commit_sha, entry, artifact_key,
submitted_by, reviewed_by, reviewed_at, reason,
metadata_json, created_at, updated_at
UNIQUE (kind, source_hash)
```

Call `migrateReviewedVersions(db)` at startup. `PostgresReviewedVersionRepository`
is the production adapter; `MemoryReviewedVersionRepository` is the test/local
fake.

## Policy notes

- Review is per exact source hash; there is no wildcard, branch, repo-level or
  "trust this author forever" approval.
- Reviewers are host-authorized; contracts cannot self-approve.
- No living-roster or matchmaker deployment should bypass this gate in
  production. Existing local tests and direct `ContractService.deploy` calls are
  development tools, not the production route.
- The gate is deliberately small: it does not execute, build or inspect code;
  it records the decision made by the review process.
