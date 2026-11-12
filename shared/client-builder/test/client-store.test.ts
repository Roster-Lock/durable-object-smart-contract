import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETENTION,
  MemoryClientArtifactStore,
  MemoryClientBuildRepository,
  PostgresClientBuildRepository,
  immediateStep,
  runClientBuildWorkflow,
  applyRetention,
  banClientBuild,
  planRetention,
  recordClientBuildUsage,
  type ClientBuildRecord,
} from "@roster-lock/smart-contract-client-builder";
import { freshTestDatabase } from "@roster-lock/smart-contract-test-client";
import { buildClientZip, makeClientZip, memoryDeps } from "@roster-lock/smart-contract-test-client/client";

function tinyZip(): Uint8Array {
  return makeClientZip(
    {
      "src/client.js": `
        export default function createClient() {
          const node = document.createElement("div");
          node.textContent = "hello";
          return node;
        }
      `,
    },
    { entry: "src/client.js", framework: "vanilla" },
  );
}

function record(id: string, overrides: Partial<ClientBuildRecord> = {}): ClientBuildRecord {
  return {
    id,
    status: "ready",
    name: "test-client",
    version: "1.0.0",
    entry: "src/client.js",
    framework: "vanilla",
    sourceHash: "sha256:a",
    lockfileHash: "sha256:b",
    bundleHash: "sha256:c",
    sizes: {
      archiveBytes: 1,
      unpackedBytes: 2,
      preOptimizationBytes: 3,
      bundleBytes: 4,
      assetBytes: 5,
    },
    keys: {
      source: `${id}/source.zip`,
      lockfile: `${id}/lockfile.json`,
      manifest: `${id}/manifest.json`,
      bundle: `${id}/bundle.js`,
      assets: {},
    },
    urls: { bundle: `https://client.test/${id}/bundle.js` },
    assets: [],
    packages: [],
    diagnostics: [],
    warnings: [],
    createdAt: 10,
    updatedAt: 10,
    readyAt: 10,
    ...overrides,
  };
}

describe("client build storage", () => {
  it("deletes partial artifacts when publication fails", async () => {
    const artifacts = new MemoryClientArtifactStore({
      failPut: (key) => key.endsWith("/bundle.js"),
    });
    await expect(buildClientZip(tinyZip(), { artifacts })).rejects.toBeDefined();
    expect(artifacts.keys()).toEqual([]);
  });

  it("does not rewrite immutable artifacts when the same inputs are rebuilt", async () => {
    const memory = memoryDeps();
    const zip = tinyZip();
    const first = await runClientBuildWorkflow(memory.deps, { zip }, immediateStep);
    const putsAfterFirst = memory.artifacts.putOrder.length;
    const second = await runClientBuildWorkflow(memory.deps, { zip }, immediateStep);
    expect(second.published.record.id).toBe(first.published.record.id);
    expect(second.published.record.createdAt).toBe(first.published.record.createdAt);
    expect(memory.artifacts.putOrder.length).toBe(putsAfterFirst);
  });

  it("deletes every artifact and usage row when a build is banned", async () => {
    const repository = new MemoryClientBuildRepository();
    const artifacts = new MemoryClientArtifactStore();
    // Re-publish into this repository/store to exercise the real ban path.
    const built = await buildClientZip(tinyZip(), { artifacts, repository });
    const recordId = built.published.record.id;
    await recordClientBuildUsage({
      repository,
      rosterId: "roster-1",
      buildId: recordId,
    });
    expect(artifacts.keys().length).toBeGreaterThan(0);
    expect(await repository.listUsage(recordId)).toHaveLength(1);

    const banned = await banClientBuild({
      buildId: recordId,
      repository,
      artifacts,
      reason: "malware",
      bannedBy: "admin",
    });
    expect(banned.status).toBe("banned");
    expect(banned.banReason).toBe("malware");
    expect(banned.keys).toEqual({});
    expect(artifacts.keys()).toEqual([]);
    expect(await repository.listUsage(recordId)).toHaveLength(0);
  });

  it("round-trips build records, assets and pins through Postgres", async () => {
    const db = await freshTestDatabase();
    const repository = new PostgresClientBuildRepository(db);
    await repository.migrate();
    const value = record("b_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
      assets: [
        {
          path: "assets/logo.svg",
          key: "b_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/assets/hash.svg",
          url: "./assets/hash.svg",
          hash: "sha256:hash",
          bytes: 10,
          contentType: "image/svg+xml",
        },
      ],
      packages: [
        {
          name: "react",
          version: "18.3.1",
          integrity: "sha512-x",
          dependencies: { "loose-envify": "^1.1.0" },
        },
      ],
    });
    await repository.save(value);
    const loaded = await repository.get(value.id);
    expect(loaded).toMatchObject({
      id: value.id,
      status: "ready",
      name: "test-client",
      sizes: value.sizes,
      keys: value.keys,
    });
    expect(loaded?.assets).toHaveLength(1);
    expect(loaded?.packages[0]?.name).toBe("react");
    expect(await repository.list({ status: "ready" })).toHaveLength(1);

    await repository.setPin({
      rosterId: "roster-1",
      buildId: value.id,
      sourceRef: "refs/heads/main",
      commit: "abc",
      pinnedAt: 20,
    });
    expect(await repository.getPin("roster-1")).toMatchObject({
      rosterId: "roster-1",
      buildId: value.id,
      commit: "abc",
    });
  });

  it("applies retention by deleting artifacts and expiring rows", async () => {
    const repository = new MemoryClientBuildRepository();
    const artifacts = new MemoryClientArtifactStore();
    const value = record("b_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", { updatedAt: 0 });
    await repository.save(value);
    await artifacts.put(value.keys.source!, "zip");
    await artifacts.put(value.keys.bundle!, "js");
    const now = 400 * 86_400_000;
    const result = await applyRetention({
      records: [value],
      usedBuildIds: new Set(),
      now,
      repository,
      artifacts,
    });
    expect(result.artifactsDeleted).toEqual([value.id]);
    expect(artifacts.keys()).toEqual([]);
    expect((await repository.get(value.id))?.status).toBe("deleted");
  });

  it("plans lifecycle cleanup for unused, failed and banned rows", () => {
    const now = 400 * 86_400_000;
    const plan = planRetention(
      [
        record("ready", { updatedAt: 0 }),
        record("failed", { status: "failed", updatedAt: 0 }),
        record("banned", { status: "banned", updatedAt: 0 }),
        record("used", { updatedAt: 0 }),
      ],
      new Set(["used"]),
      now,
      DEFAULT_RETENTION,
    );
    expect(plan.deleteArtifacts).toEqual(["ready"]);
    expect(plan.deleteRows).toEqual(expect.arrayContaining(["failed", "banned"]));
  });
});
