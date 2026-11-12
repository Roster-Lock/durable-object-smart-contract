import type { GasMeter } from "../gas.js";
import type { Db, QueryResult, SqlValue } from "../sql/driver.js";
import type {
  CompiledArray,
  CompiledCollection,
  CompiledMap,
  CompiledNode,
  CompiledValue,
} from "../storage/declaration.js";
import type { ContractConfig, GasCosts, JsonValue } from "../types.js";
import { assertByteLimit, clampInt, utf8ByteLength } from "../util/bytes.js";

export const PATH_SEPARATOR = "\u001f";
const STEP = 1024;

export interface LineageEntry {
  /** Path of the parent map that the marker belongs to. */
  path: string;
  key: string;
  maxEntries?: number;
}

/**
 * A view over one node in the storage tree: a root collection or a nested map
 * or array. `lineage` records the map entries that must exist before a write
 * can land, so a nested handle can be created cheaply (no query) and only
 * materialise its ancestors when it is actually written to.
 */
export interface StorageTarget {
  collection: CompiledCollection;
  path: string;
  node: CompiledNode;
  lineage: LineageEntry[];
}

export type ArrayEntry =
  | { kind: "value"; value: string }
  | { kind: "node"; path: string; node: CompiledNode };

export type MapEntry =
  | { kind: "value"; key: string; value: string }
  | { kind: "node"; key: string; path: string; node: CompiledNode };

export function childPath(config: ContractConfig, parent: string, segment: string): string {
  const path = `${parent}${PATH_SEPARATOR}${segment}`;
  assertByteLimit(path, config.maxPathBytes, "storage path");
  return path;
}

/**
 * The host side of `StoredValue`, `StoredMap` and `StoredArray`.
 *
 * One class holds the whole tree: root collections and nested nodes are just
 * different `StorageTarget`s. Every method validates its arguments, charges
 * gas, and runs SQL inside the call's transaction. The guest never sees a
 * path, a table name or a query string.
 */
export class ContractStorage {
  constructor(
    private readonly db: Db,
    private readonly contractId: string,
    private readonly meter: GasMeter,
    private readonly costs: GasCosts,
    private readonly config: ContractConfig,
    private readOnly: boolean,
    private readonly now: () => number,
  ) {}

  /**
   * The contract's top-level code always runs read-only; only an endpoint
   * invocation or the one-time init hook may write.
   */
  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
  }

  // ------------------------------------------------------------------ Value

  async valueGet(target: StorageTarget): Promise<string | undefined> {
    this.begin();
    const node = this.asValue(target);
    const rows = await this.query<{ value: string }>(
      `SELECT value FROM dsc_state_value WHERE contract_id = $1 AND collection = $2`,
      [this.contractId, target.collection.name],
    );
    if (rows.rows.length === 0) return undefined;
    return this.readValue(node, rows.rows[0].value);
  }

  async valueSet(target: StorageTarget, json: string): Promise<void> {
    this.begin();
    const node = this.asValue(target);
    const value = this.writeValue(node, json, target.collection.name);
    await this.exec(
      `INSERT INTO dsc_state_value (contract_id, collection, value, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (contract_id, collection)
       DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [this.contractId, target.collection.name, value, this.now()],
    );
  }

  async valueDelete(target: StorageTarget): Promise<void> {
    this.begin();
    await this.exec(
      `DELETE FROM dsc_state_value WHERE contract_id = $1 AND collection = $2`,
      [this.contractId, target.collection.name],
    );
  }

  // -------------------------------------------------------------------- Map

  /** A nested-map/array child handle. Cheap: no query, just a validated path. */
  mapChild(target: StorageTarget, key: string): StorageTarget {
    this.begin();
    const node = this.asMap(target);
    this.validateKey(node.keyValidator, key);
    return {
      collection: target.collection,
      path: childPath(this.config, target.path, key),
      node: node.value,
      lineage: [
        ...target.lineage,
        { path: target.path, key, maxEntries: node.maxEntries },
      ],
    };
  }

  async mapGet(target: StorageTarget, key: string): Promise<string | undefined> {
    this.begin();
    const node = this.asMap(target);
    if (node.value.kind !== "value") {
      throw new TypeError(
        `${target.collection.name} holds nested collections here; use get() to obtain one`,
      );
    }
    this.validateKey(node.keyValidator, key);
    const rows = await this.query<{ value: string | null }>(
      `SELECT value FROM dsc_state_map
       WHERE contract_id = $1 AND collection = $2 AND path = $3 AND key = $4`,
      [this.contractId, target.collection.name, target.path, key],
    );
    const value = rows.rows[0]?.value;
    if (value === undefined) return undefined;
    if (value === null) throw new TypeError(`map key ${JSON.stringify(key)} holds a nested collection`);
    return this.readValue(node.value, value);
  }

  async mapSet(target: StorageTarget, key: string, json: string): Promise<void> {
    this.begin();
    const node = this.asMap(target);
    if (node.value.kind !== "value") {
      throw new TypeError(
        `${target.collection.name} holds nested collections here; write through get()`,
      );
    }
    this.validateKey(node.keyValidator, key);
    const value = this.writeValue(node.value, json, `${target.collection.name}.${key}`);
    await this.ensureMarkers(target);

    const inserted = await this.exec(
      `INSERT INTO dsc_state_map (contract_id, collection, path, key, value, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (contract_id, collection, path, key) DO NOTHING`,
      [this.contractId, target.collection.name, target.path, key, value, this.now()],
    );
    if (inserted === 1) {
      await this.addToCount(target.collection, target.path, 1, node.maxEntries);
    } else {
      await this.exec(
        `UPDATE dsc_state_map SET value = $5, updated_at = $6
         WHERE contract_id = $1 AND collection = $2 AND path = $3 AND key = $4`,
        [this.contractId, target.collection.name, target.path, key, value, this.now()],
      );
    }
  }

  async mapHas(target: StorageTarget, key: string): Promise<boolean> {
    this.begin();
    const node = this.asMap(target);
    this.validateKey(node.keyValidator, key);
    const rows = await this.query<{ present: number }>(
      `SELECT 1 AS present FROM dsc_state_map
       WHERE contract_id = $1 AND collection = $2 AND path = $3 AND key = $4 LIMIT 1`,
      [this.contractId, target.collection.name, target.path, key],
    );
    return rows.rows.length > 0;
  }

  async mapDelete(target: StorageTarget, key: string): Promise<void> {
    this.begin();
    const node = this.asMap(target);
    this.validateKey(node.keyValidator, key);
    const deleted = await this.exec(
      `DELETE FROM dsc_state_map
       WHERE contract_id = $1 AND collection = $2 AND path = $3 AND key = $4`,
      [this.contractId, target.collection.name, target.path, key],
    );
    if (deleted === 1) {
      await this.addToCount(target.collection, target.path, -1);
      await this.deleteSubtree(
        target.collection,
        childPath(this.config, target.path, key),
      );
    }
  }

  async mapKeys(
    target: StorageTarget,
    limitValue: unknown,
    offsetValue: unknown,
  ): Promise<string[]> {
    this.begin();
    const node = this.asMap(target);
    const limit = this.pageSize(limitValue);
    const offset = this.offset(offsetValue);
    if (limit === 0) return [];
    if (offset > 0) this.meter.charge(offset * this.costs.rowRead);
    const rows = await this.query<{ key: string }>(
      `SELECT key FROM dsc_state_map
       WHERE contract_id = $1 AND collection = $2 AND path = $3
       ORDER BY key ASC LIMIT $4 OFFSET $5`,
      [this.contractId, target.collection.name, target.path, limit, offset],
    );
    for (const row of rows.rows) this.chargeBytes(row.key);
    return rows.rows.map((row) => row.key);
  }

  async mapEntries(
    target: StorageTarget,
    limitValue: unknown,
    offsetValue: unknown,
  ): Promise<MapEntry[]> {
    this.begin();
    const node = this.asMap(target);
    const limit = this.pageSize(limitValue);
    const offset = this.offset(offsetValue);
    if (limit === 0) return [];
    if (offset > 0) this.meter.charge(offset * this.costs.rowRead);
    const rows = await this.query<{ key: string; value: string | null }>(
      `SELECT key, value FROM dsc_state_map
       WHERE contract_id = $1 AND collection = $2 AND path = $3
       ORDER BY key ASC LIMIT $4 OFFSET $5`,
      [this.contractId, target.collection.name, target.path, limit, offset],
    );
    return rows.rows.map((row) => {
      this.chargeBytes(row.key);
      if (row.value === null) {
        return {
          kind: "node" as const,
          key: row.key,
          path: childPath(this.config, target.path, row.key),
          node: node.value,
        };
      }
      if (node.value.kind !== "value") {
        throw new TypeError(`map entry ${JSON.stringify(row.key)} is not a nested collection`);
      }
      return {
        kind: "value" as const,
        key: row.key,
        value: this.readValue(node.value, row.value),
      };
    });
  }

  async mapSize(target: StorageTarget): Promise<number> {
    this.begin();
    this.asMap(target);
    return this.sizeOf(target);
  }

  async mapClear(target: StorageTarget): Promise<void> {
    this.begin();
    this.asMap(target);
    await this.deleteSubtree(target.collection, target.path);
  }

  // ------------------------------------------------------------------ Array

  async arrayGet(target: StorageTarget, index: number): Promise<ArrayEntry | undefined> {
    this.begin();
    const node = this.asArray(target);
    const offset = this.index(index);
    if (offset > this.config.maxArrayOffset) return undefined;
    if (offset > 0) this.meter.charge(offset * this.costs.rowRead);
    const rows = await this.query<{ item_id: string; value: string | null }>(
      `SELECT item_id, value FROM dsc_state_array
       WHERE contract_id = $1 AND collection = $2 AND path = $3
       ORDER BY position DESC LIMIT 1 OFFSET $4`,
      [this.contractId, target.collection.name, target.path, offset],
    );
    const row = rows.rows[0];
    if (!row) return undefined;
    return this.arrayEntry(target, node, row);
  }

  async arraySlice(
    target: StorageTarget,
    startValue: unknown,
    countValue: unknown,
  ): Promise<ArrayEntry[]> {
    this.begin();
    const node = this.asArray(target);
    const start = this.offset(startValue);
    const count = this.pageSize(countValue);
    if (count === 0) return [];
    if (start > 0) this.meter.charge(start * this.costs.rowRead);
    const rows = await this.query<{ item_id: string; value: string | null }>(
      `SELECT item_id, value FROM dsc_state_array
       WHERE contract_id = $1 AND collection = $2 AND path = $3
       ORDER BY position DESC LIMIT $4 OFFSET $5`,
      [this.contractId, target.collection.name, target.path, count, start],
    );
    return rows.rows.map((row) => this.arrayEntry(target, node, row));
  }

  /** Insert leaf items. `index` is 0-based from the top. Returns the new length. */
  async arrayInsert(
    target: StorageTarget,
    index: number,
    values: string[],
  ): Promise<number> {
    this.begin();
    const node = this.asArray(target);
    if (node.item.kind !== "value") {
      throw new TypeError(
        `${target.collection.name} holds nested collections; use push()/unshift()/create()`,
      );
    }
    if (values.length === 0) return this.sizeOf(target);
    if (values.length > this.config.maxItemsPerOperation) {
      throw new RangeError(
        `at most ${this.config.maxItemsPerOperation} items can be added at once`,
      );
    }
    const validated = values.map((value, position) =>
      this.writeValue(node.item as CompiledValue, value, `${target.collection.name}[${index + position}]`),
    );
    const length = await this.sizeOf(target);
    const at = this.insertIndex(index, length);
    await this.ensureMarkers(target);
    const positions = await this.positionsForInsert(target, at, validated.length);
    const orderedPositions = validated.map((_, position) => positions[validated.length - 1 - position]);
    const updatedAt = this.now();
    await this.exec(
      `INSERT INTO dsc_state_array
         (contract_id, collection, path, position, value, updated_at)
       SELECT $1, $2, $3, input.position, input.value, $6
       FROM unnest($4::float8[], $5::text[]) AS input(position, value)`,
      [
        this.contractId,
        target.collection.name,
        target.path,
        orderedPositions,
        validated,
        updatedAt,
      ],
    );
    await this.addToCount(target.collection, target.path, validated.length, node.maxItems);
    return length + validated.length;
  }

  /** Create an empty child node in a nested array. `index` is 0-based from the top. */
  async arrayCreate(target: StorageTarget, index: number): Promise<StorageTarget> {
    this.begin();
    const node = this.asArray(target);
    if (node.item.kind === "value") {
      throw new TypeError(`${target.collection.name} holds values; use insert()/push()`);
    }
    const length = await this.sizeOf(target);
    const at = this.insertIndex(index, length);
    await this.ensureMarkers(target);
    const positions = await this.positionsForInsert(target, at, 1);
    const rows = await this.query<{ item_id: string }>(
      `INSERT INTO dsc_state_array
         (contract_id, collection, path, position, value, updated_at)
       VALUES ($1, $2, $3, $4, NULL, $5)
       RETURNING item_id`,
      [this.contractId, target.collection.name, target.path, positions[0], this.now()],
    );
    await this.addToCount(target.collection, target.path, 1, node.maxItems);
    return {
      collection: target.collection,
      path: childPath(this.config, target.path, String(rows.rows[0].item_id)),
      node: node.item,
      lineage: target.lineage,
    };
  }

  async arraySet(target: StorageTarget, index: number, json: string): Promise<void> {
    this.begin();
    const node = this.asArray(target);
    if (node.item.kind !== "value") {
      throw new TypeError(`${target.collection.name} holds nested collections; use create()`);
    }
    const value = this.writeValue(node.item, json, `${target.collection.name}[${index}]`);
    const offset = this.index(index);
    if (offset > this.config.maxArrayOffset) {
      throw new RangeError(`array index ${index} is out of range`);
    }
    if (offset > 0) this.meter.charge(offset * this.costs.rowRead);
    const updated = await this.exec(
      `UPDATE dsc_state_array SET value = $5, updated_at = $6
       WHERE contract_id = $1 AND collection = $2 AND path = $3 AND position = (
         SELECT position FROM dsc_state_array
         WHERE contract_id = $1 AND collection = $2 AND path = $3
         ORDER BY position DESC LIMIT 1 OFFSET $4
       )`,
      [this.contractId, target.collection.name, target.path, offset, value, this.now()],
    );
    if (updated !== 1) throw new RangeError(`array index ${index} is out of range`);
  }

  async arrayRemoveAt(
    target: StorageTarget,
    index: number,
    countValue: unknown,
  ): Promise<string[]> {
    this.begin();
    const node = this.asArray(target);
    const length = await this.sizeOf(target);
    const offset = this.index(index);
    if (offset >= length || offset > this.config.maxArrayOffset) return [];
    if (offset > 0) this.meter.charge(offset * this.costs.rowRead);
    const count = Math.min(
      clampInt(countValue, 0, this.config.maxItemsPerOperation),
      length - offset,
    );
    if (count === 0) return [];

    const rows = await this.query<{ item_id: string; value: string | null; position: number }>(
      `SELECT item_id, value, position FROM dsc_state_array
       WHERE contract_id = $1 AND collection = $2 AND path = $3
       ORDER BY position DESC LIMIT $4 OFFSET $5`,
      [this.contractId, target.collection.name, target.path, count, offset],
    );
    const positions = rows.rows.map((row) => row.position);
    await this.exec(
      `DELETE FROM dsc_state_array
       WHERE contract_id = $1 AND collection = $2 AND path = $3
         AND position = ANY($4::float8[])`,
      [this.contractId, target.collection.name, target.path, positions],
    );
    for (const row of rows.rows) {
      if (row.value === null) {
        await this.deleteSubtree(
          target.collection,
          childPath(this.config, target.path, String(row.item_id)),
        );
      }
    }
    await this.addToCount(target.collection, target.path, -rows.rows.length);

    if (node.item.kind !== "value") return [];
    return rows.rows
      .filter((row): row is { item_id: string; value: string; position: number } => row.value !== null)
      .map((row) => this.readValue(node.item as CompiledValue, row.value));
  }

  async arrayMove(target: StorageTarget, from: number, to: number): Promise<void> {
    this.begin();
    this.asArray(target);
    const length = await this.sizeOf(target);
    const fromIndex = this.index(from);
    if (fromIndex >= length || fromIndex > this.config.maxArrayOffset) {
      throw new RangeError(`array index ${from} is out of range`);
    }
    if (fromIndex > 0) this.meter.charge(fromIndex * this.costs.rowRead);
    const targetIndex = clampInt(to, 0, Math.max(0, length - 1));
    if (fromIndex === targetIndex) return;

    const rows = await this.query<{ item_id: string; value: string | null }>(
      `SELECT item_id, value FROM dsc_state_array
       WHERE contract_id = $1 AND collection = $2 AND path = $3
       ORDER BY position DESC LIMIT 1 OFFSET $4`,
      [this.contractId, target.collection.name, target.path, fromIndex],
    );
    const item = rows.rows[0];
    if (!item) throw new RangeError(`array index ${from} is out of range`);

    await this.exec(
      `DELETE FROM dsc_state_array
       WHERE contract_id = $1 AND collection = $2 AND item_id = $3`,
      [this.contractId, target.collection.name, item.item_id],
    );

    const newLength = length - 1;
    const at = Math.min(targetIndex, newLength);
    const positions = await this.positionsForInsert(target, at, 1);
    await this.exec(
      `INSERT INTO dsc_state_array
         (contract_id, collection, path, item_id, position, value, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        this.contractId,
        target.collection.name,
        target.path,
        item.item_id,
        positions[0],
        item.value,
        this.now(),
      ],
    );
  }

  async arrayMoveToTop(target: StorageTarget, from: number): Promise<void> {
    await this.arrayMove(target, from, 0);
  }

  async arrayMoveToBottom(target: StorageTarget, from: number): Promise<void> {
    this.begin();
    const length = await this.sizeOf(target);
    await this.arrayMove(target, from, Math.max(0, length - 1));
  }

  async arrayLength(target: StorageTarget): Promise<number> {
    this.begin();
    this.asArray(target);
    return this.sizeOf(target);
  }

  async arrayClear(target: StorageTarget): Promise<void> {
    this.begin();
    this.asArray(target);
    await this.deleteSubtree(target.collection, target.path);
  }

  // ---------------------------------------------------------------- seeding

  /** Seed one root collection inside the deploy transaction. */
  async seed(collection: CompiledCollection, initial: unknown): Promise<void> {
    await this.seedNode(
      { collection, path: "", node: collection.node, lineage: [] },
      initial,
    );
  }

  private async seedNode(target: StorageTarget, initial: unknown): Promise<void> {
    if (target.node.kind === "value") {
      const rows = await this.query(
        `SELECT 1 FROM dsc_state_value WHERE contract_id = $1 AND collection = $2`,
        [this.contractId, target.collection.name],
      );
      if (rows.rows.length === 0) {
        await this.valueSet(target, JSON.stringify(initial));
      }
      return;
    }

    if (target.node.kind === "map") {
      const node = target.node;
      for (const [key, value] of Object.entries(initial as Record<string, unknown>)) {
        const child = this.mapChild(target, key);
        if (node.value.kind === "value") {
          await this.mapSet(target, key, JSON.stringify(value));
        } else {
          await this.ensureMarkers(child);
          await this.seedNode(child, value);
        }
      }
      return;
    }

    const items = initial as unknown[];
    // Insert from the end at the top: the result keeps initial[0] at index 0.
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      if (target.node.item.kind === "value") {
        await this.arrayInsert(target, 0, [JSON.stringify(item)]);
      } else {
        const child = await this.arrayCreate(target, 0);
        await this.seedNode(child, item);
      }
    }
  }

  // -------------------------------------------------------------- internals

  private begin(): void {
    this.meter.charge(this.costs.hostCall);
  }

  private asValue(target: StorageTarget): CompiledValue {
    if (target.node.kind !== "value") {
      throw new TypeError(`${target.collection.name} is not a value collection`);
    }
    return target.node;
  }

  private asMap(target: StorageTarget): CompiledMap {
    if (target.node.kind !== "map") {
      throw new TypeError(`${target.collection.name} is not a map`);
    }
    return target.node;
  }

  private asArray(target: StorageTarget): CompiledArray {
    if (target.node.kind !== "array") {
      throw new TypeError(`${target.collection.name} is not an array`);
    }
    return target.node;
  }

  private async query<T extends Record<string, SqlValue>>(
    sql: string,
    params: readonly SqlValue[],
  ): Promise<QueryResult<T>> {
    this.meter.charge(this.costs.statement);
    const result = await this.db.query<T>(sql, params);
    this.meter.charge(
      result.rows.length * this.costs.rowRead +
        result.rowCount * this.costs.rowWritten,
    );
    return result;
  }

  private async exec(sql: string, params: readonly SqlValue[]): Promise<number> {
    if (this.readOnly) {
      throw new Error(
        "contract storage is read-only while the contract is loaded for deployment",
      );
    }
    this.meter.charge(this.costs.statement);
    const result = await this.db.query(sql, params);
    this.meter.charge(result.rowCount * this.costs.rowWritten);
    return result.rowCount;
  }

  private async sizeOf(target: StorageTarget): Promise<number> {
    return this.countFor(target.collection, target.path);
  }

  private async countFor(
    collection: CompiledCollection,
    path: string,
  ): Promise<number> {
    const rows = await this.query<{ item_count: string }>(
      `SELECT item_count FROM dsc_state_size
       WHERE contract_id = $1 AND collection = $2 AND path = $3`,
      [this.contractId, collection.name, path],
    );
    return Number(rows.rows[0]?.item_count ?? 0);
  }

  private async addToCount(
    collection: CompiledCollection,
    path: string,
    delta: number,
    max?: number,
  ): Promise<number> {
    if (delta === 0) return this.countFor(collection, path);
    const rows = await this.query<{ item_count: string }>(
      `INSERT INTO dsc_state_size (contract_id, collection, path, item_count)
       VALUES ($1, $2, $3, GREATEST(0, $4))
       ON CONFLICT (contract_id, collection, path)
       DO UPDATE SET item_count = GREATEST(0, dsc_state_size.item_count + $4)
       RETURNING item_count`,
      [this.contractId, collection.name, path, delta],
    );
    const count = Number(rows.rows[0]?.item_count ?? 0);
    if (max !== undefined && count > max) {
      throw new RangeError(`${collection.name} allows at most ${max} entries`);
    }
    return count;
  }

  private async ensureMarkers(target: StorageTarget): Promise<void> {
    for (const entry of target.lineage) {
      const inserted = await this.exec(
        `INSERT INTO dsc_state_map (contract_id, collection, path, key, value, updated_at)
         VALUES ($1, $2, $3, $4, NULL, $5)
         ON CONFLICT (contract_id, collection, path, key) DO NOTHING`,
        [this.contractId, target.collection.name, entry.path, entry.key, this.now()],
      );
      if (inserted === 1) {
        await this.addToCount(target.collection, entry.path, 1, entry.maxEntries);
      }
    }
  }

  private async deleteSubtree(
    collection: CompiledCollection,
    basePath: string,
  ): Promise<void> {
    const prefix = `${basePath}${PATH_SEPARATOR}`;
    for (const table of ["dsc_state_map", "dsc_state_array", "dsc_state_size"]) {
      await this.exec(
        `DELETE FROM ${table}
         WHERE contract_id = $1 AND collection = $2
           AND (path = $3 OR starts_with(path, $4))`,
        [this.contractId, collection.name, basePath, prefix],
      );
    }
  }

  private async positionAt(target: StorageTarget, offset: number): Promise<number | undefined> {
    if (offset < 0) return undefined;
    if (offset > 0) this.meter.charge(offset * this.costs.rowRead);
    const rows = await this.query<{ position: number }>(
      `SELECT position FROM dsc_state_array
       WHERE contract_id = $1 AND collection = $2 AND path = $3
       ORDER BY position DESC LIMIT 1 OFFSET $4`,
      [this.contractId, target.collection.name, target.path, offset],
    );
    return rows.rows[0]?.position;
  }

  private async positionsForInsert(
    target: StorageTarget,
    index: number,
    count: number,
  ): Promise<number[]> {
    let bounds = await this.insertionBounds(target, index);
    let positions = allocatePositions(bounds.lower, bounds.upper, count);
    if (positions === undefined) {
      await this.renumber(target);
      bounds = await this.insertionBounds(target, index);
      positions = allocatePositions(bounds.lower, bounds.upper, count);
      if (positions === undefined) {
        throw new Error("could not allocate array positions");
      }
    }
    return positions;
  }

  private async insertionBounds(
    target: StorageTarget,
    index: number,
  ): Promise<{ lower: number; upper: number }> {
    const before = index > 0 ? await this.positionAt(target, index - 1) : undefined;
    const after = await this.positionAt(target, index);
    return {
      lower: after ?? Number.NEGATIVE_INFINITY,
      upper: before ?? Number.POSITIVE_INFINITY,
    };
  }

  private async renumber(target: StorageTarget): Promise<void> {
    const rows = await this.query<{ item_id: string; value: string | null }>(
      `SELECT item_id, value FROM dsc_state_array
       WHERE contract_id = $1 AND collection = $2 AND path = $3
       ORDER BY position ASC`,
      [this.contractId, target.collection.name, target.path],
    );
    if (rows.rows.length === 0) return;
    await this.exec(
      `DELETE FROM dsc_state_array
       WHERE contract_id = $1 AND collection = $2 AND path = $3`,
      [this.contractId, target.collection.name, target.path],
    );
    const ids = rows.rows.map((row) => row.item_id);
    const values = rows.rows.map((row) => row.value);
    const positions = rows.rows.map((_, index) => (index + 1) * STEP);
    await this.exec(
      `INSERT INTO dsc_state_array
         (contract_id, collection, path, item_id, position, value, updated_at)
       SELECT $1, $2, $3, input.item_id, input.position, input.value, $6
       FROM unnest($4::bigint[], $5::float8[], $7::text[])
         AS input(item_id, position, value)`,
      [
        this.contractId,
        target.collection.name,
        target.path,
        ids,
        positions,
        this.now(),
        values,
      ],
    );
  }

  private arrayEntry(
    target: StorageTarget,
    node: CompiledArray,
    row: { item_id: string; value: string | null },
  ): ArrayEntry {
    if (row.value === null) {
      return {
        kind: "node",
        path: childPath(this.config, target.path, String(row.item_id)),
        node: node.item,
      };
    }
    if (node.item.kind !== "value") {
      throw new TypeError(`${target.collection.name} item is missing its nested collection`);
    }
    return { kind: "value", value: this.readValue(node.item, row.value) };
  }

  private insertIndex(value: number, length: number): number {
    if (!Number.isInteger(value) || value < 0 || value > length) {
      throw new RangeError(`array index ${value} is out of range (0..${length})`);
    }
    return value;
  }

  private index(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new RangeError(`array index must be a non-negative integer`);
    }
    return value;
  }

  private pageSize(value: unknown): number {
    return clampInt(value, 0, this.config.maxPageSize);
  }

  private offset(value: unknown): number {
    return clampInt(value, 0, this.config.maxArrayOffset);
  }

  private validateKey(
    validator: CompiledMap["keyValidator"],
    key: string,
  ): void {
    if (typeof key !== "string") throw new TypeError("map key must be a string");
    if (key.includes(PATH_SEPARATOR)) {
      throw new TypeError("map key cannot contain the storage path separator");
    }
    assertByteLimit(key, this.config.maxKeyBytes, "map key");
    if (!validator) return;
    const result = validator.validate(key);
    if (!result.valid) {
      const first = result.errors[0];
      throw new TypeError(
        `map key ${JSON.stringify(key)} does not match its schema: ${
          first ? first.error : "invalid"
        }`,
      );
    }
    this.meter.charge(this.costs.schemaValidation);
  }

  private readValue(node: CompiledValue, json: string): string {
    if (node.validateReads) {
      this.assertSchema(node, json, "stored value");
    }
    this.chargeBytes(json);
    return json;
  }

  private writeValue(node: CompiledValue, json: string, label: string): string {
    if (typeof json !== "string") {
      throw new TypeError(`${label} must be JSON text`);
    }
    const bytes = assertByteLimit(json, this.config.maxValueBytes, label);
    this.assertSchema(node, json, label);
    this.meter.charge(bytes * this.costs.byte);
    return json;
  }

  private assertSchema(node: CompiledValue, json: string, label: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new TypeError(`${label} is not valid JSON`);
    }
    const result = node.validator.validate(parsed);
    if (!result.valid) {
      const first = result.errors[0];
      throw new TypeError(
        `${label} does not match its schema: ${
          first ? `${first.instanceLocation} ${first.error}` : "invalid"
        }`,
      );
    }
    this.meter.charge(this.costs.schemaValidation);
  }

  private chargeBytes(value: string): void {
    this.meter.charge(utf8ByteLength(value) * this.costs.byte);
  }
}

/**
 * Positions strictly between `lower` and `upper`, ascending.
 * Returns undefined when floating point cannot fit them, which triggers a
 * renumber and a retry.
 */
export function allocatePositions(
  lower: number,
  upper: number,
  count: number,
): number[] | undefined {
  if (count <= 0) return [];
  if (count > 1_000_000) return undefined;

  if (!Number.isFinite(lower) && !Number.isFinite(upper)) {
    return Array.from({ length: count }, (_, index) => (index + 1) * STEP);
  }
  if (!Number.isFinite(upper)) {
    return Array.from({ length: count }, (_, index) => lower + (index + 1) * STEP);
  }
  if (!Number.isFinite(lower)) {
    return Array.from({ length: count }, (_, index) => upper - (count - index) * STEP);
  }

  const gap = upper - lower;
  if (!(gap > 0)) return undefined;
  const step = gap / (count + 1);
  if (!(step > 0) || !Number.isFinite(step)) return undefined;

  const positions: number[] = [];
  for (let index = 0; index < count; index++) {
    positions.push(lower + step * (index + 1));
  }
  for (let index = 0; index < count; index++) {
    const position = positions[index];
    if (!(position > lower) || !(position < upper)) return undefined;
    if (index > 0 && !(position > positions[index - 1])) return undefined;
  }
  return positions;
}
