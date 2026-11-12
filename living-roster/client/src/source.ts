import type { ClientHost } from "@roster-lock/smart-contract-sdk";
import {
  filterListOptions,
  type FetchableSource,
  type ListOption,
  type ListValueFilter,
} from "./model.js";

export type SourceMode = "options" | "values";

export interface SourceValues {
  options: ListOption[];
  values: Set<string>;
}

const SOURCE_CACHE = new WeakMap<ClientHost, Map<string, Promise<SourceValues>>>();

/** Clear cached source reads, e.g. after a call that may change a list. */
export function clearSourceCache(host: ClientHost): void {
  SOURCE_CACHE.delete(host);
}

/**
 * Fetch and normalize declared list sources.
 *
 * Source endpoints are validated as public/human and `mutates: false` before
 * the call. Results may be an array or `{ items: [] }` / `{ values: [] }`.
 * `labeled-value` sources require every item to be `{ value, label }`.
 */
export async function resolveSourceValues(
  host: ClientHost,
  sources: readonly FetchableSource[],
  mode: SourceMode,
  requireLabel: boolean,
): Promise<SourceValues> {
  if (sources.length === 0) return { options: [], values: new Set<string>() };
  const results = await Promise.all(
    sources.map((source) => fetchSource(host, source, mode, requireLabel)),
  );
  const options: ListOption[] = [];
  const values = new Set<string>();
  for (const result of results) {
    for (const option of result.options) options.push(option);
    for (const item of result.values) values.add(item);
  }
  return { options, values };
}

export async function fetchSource(
  host: ClientHost,
  source: FetchableSource,
  mode: SourceMode,
  requireLabel: boolean,
): Promise<SourceValues> {
  let byHost = SOURCE_CACHE.get(host);
  if (!byHost) {
    byHost = new Map();
    SOURCE_CACHE.set(host, byHost);
  }
  const key = `${source.handle}\0${source.endpoint}\0${mode}\0${requireLabel ? "label" : "value"}`;
  const cached = byHost.get(key);
  if (cached) return cached;
  const promise = (async () => {
    const contract = await host.roster.getContract(source.handle);
    if (!contract) throw new Error(`list source contract ${source.handle} was not found`);
    const endpoint = contract.endpoints[source.endpoint];
    if (!endpoint) {
      throw new Error(`list source endpoint ${source.handle}.${source.endpoint} was not found`);
    }
    if (endpoint.access && endpoint.access !== "public" && endpoint.access !== "human") {
      throw new Error(
        `list source ${source.handle}.${source.endpoint} is not callable by a browser client`,
      );
    }
    if (endpoint.mutates !== false) {
      throw new Error(
        `list source ${source.handle}.${source.endpoint} must declare mutates:false`,
      );
    }
    const result = await host.roster.call(source.handle, source.endpoint, undefined);
    const items = extractItems(result);
    const options: ListOption[] = [];
    const values = new Set<string>();
    for (const item of items) {
      const option = mode === "options" ? toOption(item, requireLabel) : toValueOption(item);
      if (!option) {
        if (mode === "options" && requireLabel) {
          throw new Error(
            `labeled-value source ${source.handle}.${source.endpoint} must return { value, label } items`,
          );
        }
        continue;
      }
      options.push(option);
      values.add(option.value);
    }
    return { options, values };
  })();
  byHost.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    byHost.delete(key);
    throw error;
  }
}

export function filterResolvedOptions(
  options: readonly ListOption[],
  include: ReadonlySet<string> | undefined,
  exclude: ReadonlySet<string>,
): ListOption[] {
  return filterListOptions(options, {
    ...(include ? { include } : {}),
    exclude,
  } as ListValueFilter);
}

function extractItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.items)) return record.items;
    if (Array.isArray(record.values)) return record.values;
    if (Array.isArray(record.data)) return record.data;
  }
  throw new Error("list source must return an array or { items: [] }");
}

function toOption(item: unknown, requireLabel: boolean): ListOption | undefined {
  if (requireLabel) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    if (typeof record.value !== "string" || typeof record.label !== "string") return undefined;
    if (!record.value || !record.label) return undefined;
    return { value: record.value, label: record.label.slice(0, 200) };
  }
  if (typeof item === "string" && item.length > 0) return { value: item, label: item };
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const record = item as Record<string, unknown>;
  const value = record.value ?? record.id;
  if (typeof value !== "string" || value.length === 0) return undefined;
  const label = record.label ?? record.title ?? record.displayName ?? record.name;
  return {
    value,
    label: typeof label === "string" && label.length > 0 ? label.slice(0, 200) : value,
  };
}

function toValueOption(item: unknown): ListOption | undefined {
  if (typeof item === "string" && item.length > 0) return { value: item, label: item };
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const record = item as Record<string, unknown>;
  const value = record.value ?? record.id;
  if (typeof value !== "string" || value.length === 0) return undefined;
  const label = record.label ?? record.title ?? record.displayName ?? record.name ?? value;
  return { value, label: typeof label === "string" ? label.slice(0, 200) : value };
}
