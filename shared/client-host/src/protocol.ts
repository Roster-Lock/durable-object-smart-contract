import type { ClientHost, ClientSession, ConfirmInput } from "@roster-lock/smart-contract-sdk";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const CLIENT_BRIDGE_CHANNEL = "roster-lock/client-bridge";
export const CLIENT_BRIDGE_PROTOCOL = 1;
export const CLIENT_IFRAME_SANDBOX = "allow-scripts allow-forms";
export const DEFAULT_BRIDGE_TIMEOUT_MS = 15_000;
export const MAX_BRIDGE_MESSAGE_BYTES = 512 * 1024;
export const MAX_CONFIRM_MESSAGE_LENGTH = 4_000;

export const CLIENT_BRIDGE_METHODS = [
  "matchmaker.getPlayer",
  "matchmaker.getLadder",
  "matchmaker.getRecentMatches",
  "roster.listContracts",
  "roster.getContract",
  "roster.getStorage",
  "roster.call",
  "catalog.getPiece",
  "catalog.searchPieces",
  "catalog.getUser",
  "catalog.searchUsers",
  "confirm",
] as const;

export type ClientBridgeMethod = (typeof CLIENT_BRIDGE_METHODS)[number];

export interface SerializedClientError {
  name: string;
  message: string;
  code?: string;
  details?: JsonValue;
}

export interface BridgeHello {
  channel: typeof CLIENT_BRIDGE_CHANNEL;
  protocol: typeof CLIENT_BRIDGE_PROTOCOL;
  kind: "hello";
  token: string;
}

export interface BridgeInit {
  channel: typeof CLIENT_BRIDGE_CHANNEL;
  protocol: typeof CLIENT_BRIDGE_PROTOCOL;
  kind: "init";
  token: string;
  session: ClientSession;
  methods: readonly ClientBridgeMethod[];
  timeoutMs: number;
}

export interface BridgeMounted {
  channel: typeof CLIENT_BRIDGE_CHANNEL;
  protocol: typeof CLIENT_BRIDGE_PROTOCOL;
  kind: "mounted";
  token: string;
  height: number;
}

export interface BridgeResize {
  channel: typeof CLIENT_BRIDGE_CHANNEL;
  protocol: typeof CLIENT_BRIDGE_PROTOCOL;
  kind: "resize";
  token: string;
  height: number;
}

export interface BridgeError {
  channel: typeof CLIENT_BRIDGE_CHANNEL;
  protocol: typeof CLIENT_BRIDGE_PROTOCOL;
  kind: "error";
  token: string;
  error: SerializedClientError;
  phase: "load" | "runtime" | "mount";
}

export interface BridgeRequest {
  channel: typeof CLIENT_BRIDGE_CHANNEL;
  protocol: typeof CLIENT_BRIDGE_PROTOCOL;
  kind: "request";
  token: string;
  id: string;
  method: ClientBridgeMethod;
  params: JsonValue[];
}

export interface BridgeResponse {
  channel: typeof CLIENT_BRIDGE_CHANNEL;
  protocol: typeof CLIENT_BRIDGE_PROTOCOL;
  kind: "response";
  token: string;
  id: string;
  ok: boolean;
  result?: JsonValue;
  error?: SerializedClientError;
}

export interface BridgeCancel {
  channel: typeof CLIENT_BRIDGE_CHANNEL;
  protocol: typeof CLIENT_BRIDGE_PROTOCOL;
  kind: "cancel";
  token: string;
  id: string;
}

export type ClientBridgeMessage =
  | BridgeHello
  | BridgeInit
  | BridgeMounted
  | BridgeResize
  | BridgeError
  | BridgeRequest
  | BridgeResponse
  | BridgeCancel;

export function isBridgeEnvelope(value: unknown): value is { channel: string; protocol: number; kind: string; token: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return (
    message.channel === CLIENT_BRIDGE_CHANNEL &&
    message.protocol === CLIENT_BRIDGE_PROTOCOL &&
    typeof message.kind === "string" &&
    typeof message.token === "string"
  );
}

export function serializeError(error: unknown): SerializedClientError {
  if (error && typeof error === "object") {
    const value = error as { name?: unknown; message?: unknown; code?: unknown; details?: unknown };
    const message = typeof value.message === "string" ? value.message : "client error";
    return {
      name: typeof value.name === "string" ? value.name : "Error",
      message: message.slice(0, 2_000),
      ...(typeof value.code === "string" ? { code: value.code.slice(0, 120) } : {}),
      ...(isJsonValue(value.details) ? { details: value.details } : {}),
    };
  }
  return { name: "Error", message: String(error).slice(0, 2_000) };
}

export class ClientBridgeError extends Error {
  readonly code?: string;
  readonly details?: JsonValue;
  constructor(error: SerializedClientError) {
    super(error.message);
    this.name = error.name || "ClientBridgeError";
    this.code = error.code;
    this.details = error.details;
  }
}

export function deserializeError(error: SerializedClientError): ClientBridgeError {
  return new ClientBridgeError(error);
}

/**
 * JSON is the bridge format. Functions, symbols, BigInt, undefined and cycles
 * are rejected rather than passed through a structured clone: no host function
 * or object reference may cross the boundary.
 */
export function toBridgeJson(value: unknown, path = "$", depth = 0): JsonValue {
  if (depth > 20) throw new TypeError(`${path} is nested too deeply for the client bridge`);
  if (value === null) return null;
  const type = typeof value;
  if (type === "string") return value as string;
  if (type === "boolean") return value as boolean;
  if (type === "number") {
    if (!Number.isFinite(value as number)) throw new TypeError(`${path} is not a finite number`);
    return value as number;
  }
  if (type === "undefined") return null;
  if (type === "function" || type === "symbol" || type === "bigint") {
    throw new TypeError(`${path} is ${type}; only JSON values may cross the client bridge`);
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new TypeError(`${path} has too many array items`);
    return value.map((item, index) => toBridgeJson(item, `${path}[${index}]`, depth + 1));
  }
  if (type === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} is not a plain object; only JSON values may cross the bridge`);
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 1_000) throw new TypeError(`${path} has too many object keys`);
    const output: Record<string, JsonValue> = {};
    for (const [key, item] of entries) {
      output[key] = toBridgeJson(item, `${path}.${key}`, depth + 1);
    }
    return output;
  }
  throw new TypeError(`${path} cannot cross the client bridge`);
}

export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 20) return false;
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "boolean") return true;
  if (type === "number") return Number.isFinite(value as number);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (type === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(value as Record<string, unknown>).every((item) =>
      isJsonValue(item, depth + 1),
    );
  }
  return false;
}

export function assertBridgeMessageSize(message: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(message);
  } catch {
    throw new Error("bridge message is not JSON-serializable");
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > MAX_BRIDGE_MESSAGE_BYTES) {
    throw new Error(`bridge message is ${bytes} bytes; limit is ${MAX_BRIDGE_MESSAGE_BYTES}`);
  }
}

export function isClientBridgeMethod(value: string): value is ClientBridgeMethod {
  return (CLIENT_BRIDGE_METHODS as readonly string[]).includes(value);
}

export function tokenFromLocationHash(hash: string): string | undefined {
  const value = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(value);
  return params.get("roster-token") ?? undefined;
}

export function bridgeTokenForDocument(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type { ClientHost, ClientSession, ConfirmInput };
