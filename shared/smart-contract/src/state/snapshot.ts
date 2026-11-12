import type { GasMeter } from "../gas.js";
import type { Db } from "../sql/driver.js";
import type {
  ContractConfig,
  ContractManifest,
  JsonValue,
} from "../types.js";
import { parseStorage } from "../storage/declaration.js";
import {
  ContractStorage,
  type StorageTarget,
} from "./collections.js";

export type StorageSnapshotNode =
  | { kind: "value"; value: JsonValue | undefined }
  | { kind: "map"; value: Record<string, StorageSnapshotNode> }
  | { kind: "array"; value: StorageSnapshotNode[] };

export type StorageSnapshot = Record<string, StorageSnapshotNode>;

/**
 * Read a contract's declared storage into a read-only JSON tree. The tree is
 * handed to sibling contracts through `ctx.contracts.<name>.storage`; it never
 * gives them write access.
 */
export async function snapshotStorage(
  db: Db,
  contractId: string,
  manifest: ContractManifest,
  meter: GasMeter,
  config: ContractConfig,
  now: () => number,
): Promise<StorageSnapshot> {
  const storage = new ContractStorage(
    db,
    contractId,
    meter,
    config.gasCosts,
    config,
    true,
    now,
  );
  const compiled = parseStorage(manifest.storage, config).compiled;
  const out: StorageSnapshot = {};
  for (const collection of compiled.values()) {
    const target: StorageTarget = {
      collection,
      path: "",
      node: collection.node,
      lineage: [],
    };
    out[collection.name] = await exportNode(storage, target, config, 0);
  }
  return out;
}

async function exportNode(
  storage: ContractStorage,
  target: StorageTarget,
  config: ContractConfig,
  depth: number,
): Promise<StorageSnapshotNode> {
  if (depth > config.maxStorageDepth) {
    throw new Error("storage snapshot exceeded the maximum depth");
  }
  const node = target.node;
  if (node.kind === "value") {
    const json = await storage.valueGet(target);
    return { kind: "value", value: json === undefined ? undefined : (JSON.parse(json) as JsonValue) };
  }
  if (node.kind === "map") {
    const values: Record<string, StorageSnapshotNode> = {};
    let offset = 0;
    while (true) {
      const entries = await storage.mapEntries(target, config.maxPageSize, offset);
      if (entries.length === 0) break;
      for (const entry of entries) {
        values[entry.key] =
          entry.kind === "value"
            ? { kind: "value", value: JSON.parse(entry.value) as JsonValue }
            : await exportNode(
                storage,
                {
                  collection: target.collection,
                  path: entry.path,
                  node: entry.node,
                  lineage: [],
                },
                config,
                depth + 1,
              );
      }
      offset += entries.length;
      if (entries.length < config.maxPageSize) break;
    }
    return { kind: "map", value: values };
  }
  const length = await storage.arrayLength(target);
  const values: StorageSnapshotNode[] = [];
  let offset = 0;
  while (offset < length) {
    const entries = await storage.arraySlice(
      target,
      offset,
      Math.min(config.maxPageSize, length - offset),
    );
    if (entries.length === 0) break;
    for (const entry of entries) {
      values.push(
        entry.kind === "value"
          ? { kind: "value", value: JSON.parse(entry.value) as JsonValue }
          : await exportNode(
              storage,
              {
                collection: target.collection,
                path: entry.path,
                node: entry.node,
                lineage: [],
              },
              config,
              depth + 1,
            ),
      );
    }
    offset += entries.length;
  }
  return { kind: "array", value: values };
}
