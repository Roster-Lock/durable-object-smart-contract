import type { RosterContract, RosterEndpoint } from "@roster-lock/smart-contract-sdk";
import { buildFormUiSchema } from "@roster-lock/smart-contract-sdk/react";
import type { UiSchema } from "@rjsf/utils";

export interface EndpointFormModel {
  name: string;
  title: string;
  description?: string;
  schema: Record<string, unknown>;
  uiSchema: UiSchema;
  access: NonNullable<RosterEndpoint["access"]>;
  mutates: boolean;
  gasLimit?: number;
  /** Public/human endpoints can be invoked from a browser client. */
  callable: boolean;
  hasInput: boolean;
  confirmTitle: string;
  confirmMessage: string;
}

/**
 * Build the data-only model for a contract's generated client.
 *
 * Everything here comes from the contract manifest. No contract-supplied code
 * or raw RJSF uiSchema is used; only JSON Schema text and an allowlisted set of
 * `x-roster-*` hints.
 */

export interface FetchableSource {
  handle: string;
  endpoint: string;
}

export type XRosterListConfig = {
  type: "piece" | "user";
  include?: FetchableSource[];
  exclude?: FetchableSource[];
};

export type XFetchableListConfig = {
  type: "labeled-value";
  include: FetchableSource[];
  exclude?: FetchableSource[];
};

export type XRosterList = XRosterListConfig | XFetchableListConfig;

export type ListSourceSpec =
  | {
      kind: "piece" | "user";
      include?: FetchableSource[];
      exclude?: FetchableSource[];
    }
  | {
      kind: "labeled-value";
      include: FetchableSource[];
      exclude?: FetchableSource[];
    };

export interface ListOption {
  value: string;
  label: string;
}

export interface ListValueFilter {
  include?: ReadonlySet<string>;
  exclude?: ReadonlySet<string>;
}

/**
 * Parse `x-roster-list` from an endpoint input schema.
 *
 * piece/user: no include means every catalog item; include sources union
 * values; exclude sources are subtracted last.
 * labeled-value: at least one include source; values must be {value,label}.
 *
 * This is a UI/source hint, not a security boundary. Source endpoints must be
 * read-only (mutates:false) and public/human; the contract endpoint still owns
 * any authorization or invariant checks.
 */
export function parseListSource(raw: unknown): ListSourceSpec | undefined {
  if (typeof raw === "string") {
    const value = raw.trim().toLowerCase();
    if (value === "catalog:pieces" || value === "catalog:piece" || value === "pieces") {
      return { kind: "piece" };
    }
    if (value === "catalog:users" || value === "catalog:user" || value === "users") {
      return { kind: "user" };
    }
    return undefined;
  }
  if (!isRecord(raw)) return undefined;
  const type = typeof raw.type === "string" ? raw.type.toLowerCase() : "";
  const include = sourceList(raw.include);
  const exclude = sourceList(raw.exclude);
  if (raw.include !== undefined && !include) return undefined;
  if (raw.exclude !== undefined && !exclude) return undefined;
  if (type === "piece" || type === "user") {
    return {
      kind: type,
      ...(include && include.length > 0 ? { include } : {}),
      ...(exclude && exclude.length > 0 ? { exclude } : {}),
    };
  }
  if (type === "labeled-value" || type === "labeled_value" || type === "labeled") {
    if (!include || include.length === 0) return undefined;
    return {
      kind: "labeled-value",
      include,
      ...(exclude && exclude.length > 0 ? { exclude } : {}),
    };
  }
  return undefined;
}

export function filterListOptions(
  options: readonly ListOption[],
  filter: ListValueFilter = {},
): ListOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.value)) return false;
    if (filter.include && !filter.include.has(option.value)) return false;
    if (filter.exclude?.has(option.value)) return false;
    seen.add(option.value);
    return true;
  });
}

function sourceList(value: unknown): FetchableSource[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output: FetchableSource[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, 32)) {
    if (!isRecord(item)) continue;
    if (typeof item.handle !== "string" || typeof item.endpoint !== "string") continue;
    const handle = item.handle.trim();
    const endpoint = item.endpoint.trim();
    if (!handle || !endpoint || handle.length > 128 || endpoint.length > 128) continue;
    const key = `${handle}\0${endpoint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ handle, endpoint });
  }
  if (value.length === 0) return [];
  return output.length > 0 ? output : undefined;
}

export function buildEndpointFormModels(contract: RosterContract): EndpointFormModel[] {
  return Object.entries(contract.endpoints).map(([name, endpoint]) => {
    const schema: Record<string, unknown> = isRecord(endpoint.input)
      ? endpoint.input
      : { type: "object", properties: {} };
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const hasInput = Object.keys(properties).length > 0;
    const access = endpoint.access ?? "public";
    const callable = access === "public" || access === "human";
    const mutates = endpoint.mutates !== false;
    const title =
      endpoint.title ??
      stringValue(schema.title) ??
      humanize(name);
    const description = endpoint.description ?? stringValue(schema.description);
    return {
      name,
      title,
      ...(description ? { description } : {}),
      schema,
      uiSchema: buildFormUiSchema(schema),
      access,
      mutates,
      ...(typeof endpoint.gasLimit === "number" ? { gasLimit: endpoint.gasLimit } : {}),
      callable,
      hasInput,
      confirmTitle: title,
      confirmMessage: mutates
        ? `Call ${contract.name}.${name}? This is a gas-metered transaction and may charge your wallet.`
        : `Run ${contract.name}.${name}? This call is gas-metered and may charge your wallet.`,
    };
  });
}

export function visibleEndpointModels(contract: RosterContract): EndpointFormModel[] {
  return buildEndpointFormModels(contract).filter((model) => model.callable);
}

export function humanize(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^\w/, (character) => character.toUpperCase());
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
