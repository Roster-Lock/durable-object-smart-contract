# GitHub discovery workflow

Status: the catalog, build pipeline and the `share-approved` workflow are
implemented; the GitHub and R2 adapters and a deployable Worker are next.

## Posting vs building

Posting a repo only writes a `discovery_repo` row. It does not fetch, build or
copy source to R2.

A commit is built when an admin approves it or a roster adopts it:

```text
resolve repo
  → reserve/pending row
  → fetch + dearchive
  → build rollup
  → validate
  → upload R2
  → complete (ready)
```

Approval and adoption are not part of this pipeline; the marketplace app links
the built commit to a review record afterwards.

`runCommitWorkflow` exposes those stages through a step runner. In a Cloudflare
Workflow pass `step.do`:

```ts
await runCommitWorkflow(deps, params, (name, fn) => step.do(name, fn));
```

This keeps dearchive and rollup inside a durable workflow rather than a request
Worker. The GitHub fetcher/dearchiver and R2 implementation are adapters.
Private repos are out of scope; public GitHub is the first source.

## Repo identity

`discovery_repo` stores:

- `source` (`github`, `gitlab`, `other`);
- `external_id` (provider repo id, once known);
- normalized `url`.

Duplicates match by `(source, external_id)` when present, otherwise by URL.
GitHub repo IDs are more stable than URLs for forks/renames. A repo can be
posted by someone who does not own it; `created_by` is an audit field, not an
ownership claim.

## Approval and bans come from review

A commit has a build status (`pending`, `building`, `ready`, `failed`) and a
`reviewed_version_id`. Approval is **not** stored on the commit: `getCommit`
left-joins `reviewed_version` and derives `approved`/`banned` from it, so the
review record is the only source of truth. A banned review always wins.

- `share-approved` builds the commit, submits/approves the review, then links
  the commit to it.
- Adoption asks the product adopter, which calls
  `requireApproved({ kind, sourceHash })` before deploying or attaching. There
  is no "unapproved adoption with roster billing" path; unapproved code is not
  adoptable through the marketplace.
- Banned before adoption → the gate refuses it.
- Banned after adoption → the review is banned, the product revokes the
  adoption, usage rows become `banned`, the artifact is deleted, and the owner
  is notified (`banSharedCommit`).
- Ban while a build is in progress → the workflow rechecks the derived status
  before upload and completion. The remaining window between check/upload/ban
  still needs a final cleanup or a row-level guard; treat this as a known race
  to close.

## Data after a ban

Matchmaker storage is namespaced per roster and deployment
(`matchmaker:<rosterId>:<deploymentId>`), so a bad commit's data can be cleared
without touching another version.

- `banSharedCommit({ clearData: true })` clears each recorded usage's data
  namespace, deletes the R2 artifact and revokes the product adoption.
- `clearMatchmakerData(db, namespace)` deletes `dsc_state_*` rows for that
  namespace.
- To carry data to a new version, copy/snapshot the previous namespace at
  deployment. Clear only the banned deployment's namespace.
- Clearing while a runner is active needs the runner disabled first; the ban
  should stop new runs.

## Auth adapters

Discovery endpoints take a `DiscoveryUser`:

```ts
{ userId, isAdmin, githubConnection?: { login, id? } }
```

`createDiscoveryApp(api, { getUser })` is the only request-aware layer. The
worker supplies `getUser` from its session/JWT/GitHub OAuth or admin check; the
endpoint functions never read headers. The default header resolver exists for
tests and quick local use.

## Artifact policy

"Policy" means what happens to R2 artifacts and DB rows over time:

- failed builds never upload an artifact; any previous artifact is deleted;
- ready artifacts stay while at least one roster usage/pin references them;
- banned artifacts are deleted and unlinked (the source remains in git);
- superseded versions can be retained for rollback for a bounded window, then
  removed by an R2 lifecycle rule or cleanup job; roster owners are notified
  when a repo gets a newer commit rather than automatically cleaning every pin;
- the DB `artifact_key` is cleared when the object is deleted;
- source snapshots are not kept for unbuilt posts.

The client exposes `repoDiscussionUrl(repo)` so the UI can link to GitHub or
GitLab issues instead of hosting comments.

Not implemented yet: retention job, R2 lifecycle configuration, private repos,
GitHub fetcher/dearchive, R2 adapter, and the Cloudflare `WorkflowEntrypoint`
wrapper. Duplicate repo posting returns the existing repo and a `duplicate`
flag; the client can redirect to it.
