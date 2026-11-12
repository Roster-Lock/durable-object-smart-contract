import type { Db, SqlValue } from "@roster-lock/smart-contract";
import type {
  ClientBuildPin,
  ClientBuildRecord,
  ClientBuildUsage,
  ClientPackagePin,
} from "./types.js";
import { migrateClientBuilds } from "./schema.js";

export interface ArtifactPutOptions {
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

export interface ClientArtifactStore {
  put(key: string, body: Uint8Array | string, options?: ArtifactPutOptions): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
  /** Immutable public URL for an artifact key. */
  publicUrl(key: string): string;
}

export interface R2BucketLike {
  put(
    key: string,
    value: Uint8Array,
    options?: {
      httpMetadata?: { contentType?: string; cacheControl?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
}

/** R2 adapter. Keep this package Node-only; the Worker only calls the service. */
export class R2ClientArtifactStore implements ClientArtifactStore {
  constructor(
    private readonly bucket: R2BucketLike,
    private readonly baseUrl: string,
    private readonly prefix = "client-builds",
  ) {}

  async put(
    key: string,
    body: Uint8Array | string,
    options: ArtifactPutOptions = {},
  ): Promise<void> {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    await this.bucket.put(this.storageKey(key), bytes, {
      httpMetadata: {
        contentType: options.contentType ?? "application/octet-stream",
        cacheControl:
          options.cacheControl ?? "public, max-age=31536000, immutable",
      },
      ...(options.metadata ? { customMetadata: options.metadata } : {}),
    });
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const object = await this.bucket.get(this.storageKey(key));
    if (!object) return undefined;
    return new Uint8Array(await object.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(this.storageKey(key));
  }

  publicUrl(key: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}/${this.storageKey(key)
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
  }

  private storageKey(key: string): string {
    return `${this.prefix.replace(/\/+$/, "")}/${key.replace(/^\/+/, "")}`;
  }
}

export interface MemoryArtifactStoreOptions {
  baseUrl?: string;
  /** Return true to fail that put; used to test partial-artifact cleanup. */
  failPut?: (key: string, body: Uint8Array | string) => boolean;
}

export class MemoryClientArtifactStore implements ClientArtifactStore {
  private readonly objects = new Map<
    string,
    { body: Uint8Array; contentType: string; metadata?: Record<string, string> }
  >();
  readonly deleted: string[] = [];
  readonly putOrder: string[] = [];
  private readonly baseUrl: string;
  private readonly failPut?: (key: string, body: Uint8Array | string) => boolean;

  constructor(options: MemoryArtifactStoreOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://client-artifacts.test";
    this.failPut = options.failPut;
  }

  async put(
    key: string,
    body: Uint8Array | string,
    options: ArtifactPutOptions = {},
  ): Promise<void> {
    if (this.failPut?.(key, body)) throw new Error(`injected put failure for ${key}`);
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body.slice();
    this.objects.set(key, {
      body: bytes,
      contentType: options.contentType ?? "application/octet-stream",
      ...(options.metadata ? { metadata: options.metadata } : {}),
    });
    this.putOrder.push(key);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.objects.get(key)?.body;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
    this.deleted.push(key);
  }

  publicUrl(key: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}/${key.replace(/^\/+/, "")}`;
  }

  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  contentType(key: string): string | undefined {
    return this.objects.get(key)?.contentType;
  }
}

export interface ClientBuildRepository {
  save(record: ClientBuildRecord): Promise<void>;
  get(id: string): Promise<ClientBuildRecord | undefined>;
  list(filter?: {
    status?: ClientBuildRecord["status"];
    sourceRef?: string;
    limit?: number;
  }): Promise<ClientBuildRecord[]>;
  delete(id: string): Promise<void>;
  addUsage(usage: ClientBuildUsage): Promise<void>;
  listUsage(buildId: string): Promise<ClientBuildUsage[]>;
  removeUsage(buildId: string): Promise<void>;
  setPin(pin: ClientBuildPin): Promise<void>;
  getPin(rosterId: string): Promise<ClientBuildPin | undefined>;
  removePinsForBuild?(buildId: string): Promise<void>;
}

export class MemoryClientBuildRepository implements ClientBuildRepository {
  private readonly records = new Map<string, ClientBuildRecord>();
  private readonly usage = new Map<string, ClientBuildUsage[]>();
  private readonly pins = new Map<string, ClientBuildPin>();

  async save(record: ClientBuildRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  async get(id: string): Promise<ClientBuildRecord | undefined> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async list(filter: {
    status?: ClientBuildRecord["status"];
    sourceRef?: string;
    limit?: number;
  } = {}): Promise<ClientBuildRecord[]> {
    return [...this.records.values()]
      .filter((record) => !filter.status || record.status === filter.status)
      .filter((record) => !filter.sourceRef || record.sourceRef === filter.sourceRef)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.min(Math.max(filter.limit ?? 100, 1), 500))
      .map((record) => structuredClone(record));
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
    this.usage.delete(id);
    for (const [rosterId, pin] of this.pins) {
      if (pin.buildId === id) this.pins.delete(rosterId);
    }
  }

  async addUsage(usage: ClientBuildUsage): Promise<void> {
    const list = this.usage.get(usage.buildId) ?? [];
    this.usage.set(
      usage.buildId,
      [...list.filter((item) => item.rosterId !== usage.rosterId), structuredClone(usage)],
    );
  }

  async listUsage(buildId: string): Promise<ClientBuildUsage[]> {
    return (this.usage.get(buildId) ?? []).map((item) => structuredClone(item));
  }

  async removeUsage(buildId: string): Promise<void> {
    this.usage.delete(buildId);
  }

  async setPin(pin: ClientBuildPin): Promise<void> {
    this.pins.set(pin.rosterId, structuredClone(pin));
  }

  async getPin(rosterId: string): Promise<ClientBuildPin | undefined> {
    const pin = this.pins.get(rosterId);
    return pin ? structuredClone(pin) : undefined;
  }

  async removePinsForBuild(buildId: string): Promise<void> {
    for (const [rosterId, pin] of this.pins) {
      if (pin.buildId === buildId) this.pins.delete(rosterId);
    }
  }
}

interface BuildRow {
  id: string;
  status: ClientBuildRecord["status"];
  source_ref: string | null;
  commit_sha: string | null;
  name: string;
  version: string;
  entry: string;
  framework: ClientBuildRecord["framework"];
  source_hash: string | null;
  lockfile_hash: string | null;
  manifest_hash: string | null;
  bundle_hash: string | null;
  archive_bytes: string | number;
  unpacked_bytes: string | number;
  pre_optimization_bytes: string | number;
  bundle_bytes: string | number;
  asset_bytes: string | number;
  keys_json: string;
  urls_json: string;
  assets_json: string;
  packages_json: string;
  diagnostics_json: string;
  warnings_json: string;
  created_at: string | number;
  updated_at: string | number;
  ready_at: string | number | null;
  banned_at: string | number | null;
  banned_by: string | null;
  ban_reason: string | null;
  deleted_at: string | number | null;
}

/** Postgres/Hyperdrive adapter. The schema is in src/schema.ts. */
export class PostgresClientBuildRepository implements ClientBuildRepository {
  constructor(private readonly db: Db) {}

  async migrate(): Promise<void> {
    await migrateClientBuilds(this.db);
  }

  async save(record: ClientBuildRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO client_build (
         id, status, source_ref, commit_sha, name, version, entry, framework,
         source_hash, lockfile_hash, manifest_hash, bundle_hash,
         archive_bytes, unpacked_bytes, pre_optimization_bytes, bundle_bytes, asset_bytes,
         source_key, lockfile_key, manifest_key, bundle_key, keys_json, urls_json, assets_json,
         packages_json, diagnostics_json, warnings_json,
         created_at, updated_at, ready_at, banned_at, banned_by, ban_reason, deleted_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
         $22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34
       )
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         source_ref = EXCLUDED.source_ref,
         commit_sha = EXCLUDED.commit_sha,
         source_hash = EXCLUDED.source_hash,
         lockfile_hash = EXCLUDED.lockfile_hash,
         manifest_hash = EXCLUDED.manifest_hash,
         bundle_hash = EXCLUDED.bundle_hash,
         archive_bytes = EXCLUDED.archive_bytes,
         unpacked_bytes = EXCLUDED.unpacked_bytes,
         pre_optimization_bytes = EXCLUDED.pre_optimization_bytes,
         bundle_bytes = EXCLUDED.bundle_bytes,
         asset_bytes = EXCLUDED.asset_bytes,
         source_key = EXCLUDED.source_key,
         lockfile_key = EXCLUDED.lockfile_key,
         manifest_key = EXCLUDED.manifest_key,
         bundle_key = EXCLUDED.bundle_key,
         keys_json = EXCLUDED.keys_json,
         urls_json = EXCLUDED.urls_json,
         assets_json = EXCLUDED.assets_json,
         packages_json = EXCLUDED.packages_json,
         diagnostics_json = EXCLUDED.diagnostics_json,
         warnings_json = EXCLUDED.warnings_json,
         updated_at = EXCLUDED.updated_at,
         ready_at = EXCLUDED.ready_at,
         banned_at = EXCLUDED.banned_at,
         banned_by = EXCLUDED.banned_by,
         ban_reason = EXCLUDED.ban_reason,
         deleted_at = EXCLUDED.deleted_at`,
      buildParams(record),
    );
    await this.db.query(`DELETE FROM client_build_asset WHERE build_id = $1`, [record.id]);
    for (const asset of record.assets) {
      await this.db.query(
        `INSERT INTO client_build_asset
           (build_id, path, key, hash, bytes, content_type)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [record.id, asset.path, asset.key, asset.hash, asset.bytes, asset.contentType],
      );
    }
    await this.db.query(`DELETE FROM client_build_package WHERE build_id = $1`, [record.id]);
    for (const pkg of record.packages) {
      await this.db.query(
        `INSERT INTO client_build_package
           (build_id, name, version, integrity, tarball_hash, dependencies_json)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          record.id,
          pkg.name,
          pkg.version,
          pkg.integrity ?? null,
          pkg.tarballHash ?? null,
          JSON.stringify(pkg.dependencies ?? {}),
        ],
      );
    }
  }

  async get(id: string): Promise<ClientBuildRecord | undefined> {
    const result = await this.db.query<BuildRow>(`SELECT * FROM client_build WHERE id = $1`, [id]);
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async list(filter: {
    status?: ClientBuildRecord["status"];
    sourceRef?: string;
    limit?: number;
  } = {}): Promise<ClientBuildRecord[]> {
    const params: SqlValue[] = [];
    const clauses: string[] = [];
    if (filter.status) {
      params.push(filter.status);
      clauses.push(`status = $${params.length}`);
    }
    if (filter.sourceRef) {
      params.push(filter.sourceRef);
      clauses.push(`source_ref = $${params.length}`);
    }
    params.push(Math.min(Math.max(filter.limit ?? 100, 1), 500));
    const result = await this.db.query<BuildRow>(
      `SELECT * FROM client_build
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(mapRow);
  }

  async delete(id: string): Promise<void> {
    await this.db.query(`DELETE FROM client_build WHERE id = $1`, [id]);
  }

  async addUsage(usage: ClientBuildUsage): Promise<void> {
    await this.db.query(
      `INSERT INTO client_build_usage (roster_id, build_id, status, created_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (roster_id, build_id) DO UPDATE SET
         status = EXCLUDED.status,
         revoked_at = EXCLUDED.revoked_at`,
      [usage.rosterId, usage.buildId, usage.status, usage.createdAt, usage.revokedAt ?? null],
    );
  }

  async listUsage(buildId: string): Promise<ClientBuildUsage[]> {
    const result = await this.db.query<{
      roster_id: string;
      build_id: string;
      status: ClientBuildUsage["status"];
      created_at: string | number;
      revoked_at: string | number | null;
    }>(`SELECT * FROM client_build_usage WHERE build_id = $1`, [buildId]);
    return result.rows.map((row) => ({
      rosterId: row.roster_id,
      buildId: row.build_id,
      status: row.status,
      createdAt: Number(row.created_at),
      ...(row.revoked_at === null ? {} : { revokedAt: Number(row.revoked_at) }),
    }));
  }

  async removeUsage(buildId: string): Promise<void> {
    await this.db.query(`DELETE FROM client_build_usage WHERE build_id = $1`, [buildId]);
  }

  async setPin(pin: ClientBuildPin): Promise<void> {
    await this.db.query(
      `INSERT INTO client_build_pin (roster_id, build_id, source_ref, commit_sha, pinned_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (roster_id) DO UPDATE SET
         build_id = EXCLUDED.build_id,
         source_ref = EXCLUDED.source_ref,
         commit_sha = EXCLUDED.commit_sha,
         pinned_at = EXCLUDED.pinned_at`,
      [pin.rosterId, pin.buildId, pin.sourceRef ?? null, pin.commit ?? null, pin.pinnedAt],
    );
  }

  async getPin(rosterId: string): Promise<ClientBuildPin | undefined> {
    const result = await this.db.query<{
      roster_id: string;
      build_id: string;
      source_ref: string | null;
      commit_sha: string | null;
      pinned_at: string | number;
    }>(`SELECT * FROM client_build_pin WHERE roster_id = $1`, [rosterId]);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      rosterId: row.roster_id,
      buildId: row.build_id,
      ...(row.source_ref ? { sourceRef: row.source_ref } : {}),
      ...(row.commit_sha ? { commit: row.commit_sha } : {}),
      pinnedAt: Number(row.pinned_at),
    };
  }

  async removePinsForBuild(buildId: string): Promise<void> {
    await this.db.query(`DELETE FROM client_build_pin WHERE build_id = $1`, [buildId]);
  }
}

function buildParams(record: ClientBuildRecord): SqlValue[] {
  return [
    record.id,
    record.status,
    record.sourceRef ?? null,
    record.commit ?? null,
    record.name,
    record.version,
    record.entry,
    record.framework,
    record.sourceHash ?? null,
    record.lockfileHash ?? null,
    record.manifestHash ?? null,
    record.bundleHash ?? null,
    record.sizes.archiveBytes,
    record.sizes.unpackedBytes,
    record.sizes.preOptimizationBytes,
    record.sizes.bundleBytes,
    record.sizes.assetBytes,
    record.keys.source ?? null,
    record.keys.lockfile ?? null,
    record.keys.manifest ?? null,
    record.keys.bundle ?? null,
    JSON.stringify(record.keys),
    JSON.stringify(record.urls),
    JSON.stringify(record.assets),
    JSON.stringify(record.packages),
    JSON.stringify(record.diagnostics),
    JSON.stringify(record.warnings),
    record.createdAt,
    record.updatedAt,
    record.readyAt ?? null,
    record.bannedAt ?? null,
    record.bannedBy ?? null,
    record.banReason ?? null,
    record.deletedAt ?? null,
  ];
}

function mapRow(row: BuildRow): ClientBuildRecord {
  const keys = JSON.parse(row.keys_json || "{}") as ClientBuildRecord["keys"];
  const urls = JSON.parse(row.urls_json || "{}") as ClientBuildRecord["urls"];
  const packages = JSON.parse(row.packages_json || "[]") as ClientPackagePin[];
  return {
    id: row.id,
    status: row.status,
    ...(row.source_ref ? { sourceRef: row.source_ref } : {}),
    ...(row.commit_sha ? { commit: row.commit_sha } : {}),
    name: row.name,
    version: row.version,
    entry: row.entry,
    framework: row.framework,
    ...(row.source_hash ? { sourceHash: row.source_hash } : {}),
    ...(row.lockfile_hash ? { lockfileHash: row.lockfile_hash } : {}),
    ...(row.manifest_hash ? { manifestHash: row.manifest_hash } : {}),
    ...(row.bundle_hash ? { bundleHash: row.bundle_hash } : {}),
    sizes: {
      archiveBytes: Number(row.archive_bytes),
      unpackedBytes: Number(row.unpacked_bytes),
      preOptimizationBytes: Number(row.pre_optimization_bytes),
      bundleBytes: Number(row.bundle_bytes),
      assetBytes: Number(row.asset_bytes),
    },
    keys,
    urls,
    assets: JSON.parse(row.assets_json || '[]') as ClientBuildRecord['assets'],
    packages,
    diagnostics: JSON.parse(row.diagnostics_json || "[]") as ClientBuildRecord["diagnostics"],
    warnings: JSON.parse(row.warnings_json || "[]") as string[],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.ready_at === null ? {} : { readyAt: Number(row.ready_at) }),
    ...(row.banned_at === null ? {} : { bannedAt: Number(row.banned_at) }),
    ...(row.banned_by ? { bannedBy: row.banned_by } : {}),
    ...(row.ban_reason ? { banReason: row.ban_reason } : {}),
    ...(row.deleted_at === null ? {} : { deletedAt: Number(row.deleted_at) }),
  };
}
