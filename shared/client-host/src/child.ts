import type {
  CatalogClient,
  ClientApi,
  ClientFactory,
  ClientHost,
  ClientSession,
  ConfirmInput,
  LadderEntry,
  MatchmakerClient,
  Page,
  Piece,
  PlayerStats,
  RecentMatch,
  RosterClient,
  RosterContract,
  UserSummary,
} from "@roster-lock/smart-contract-sdk";
import {
  CLIENT_BRIDGE_CHANNEL,
  CLIENT_BRIDGE_PROTOCOL,
  DEFAULT_BRIDGE_TIMEOUT_MS,
  deserializeError,
  isBridgeEnvelope,
  isClientBridgeMethod,
  serializeError,
  toBridgeJson,
  tokenFromLocationHash,
  type JsonValue,
  type BridgeError,
  type BridgeInit,
  type BridgeMounted,
  type BridgeRequest,
  type BridgeResize,
  type BridgeResponse,
  type ClientBridgeMethod,
} from "./protocol.js";

interface PendingRequest {
  resolve: (value: JsonValue) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  method: ClientBridgeMethod;
}

export interface ChildBridgeOptions {
  window: Window;
  parent: Window;
  token: string;
  timeoutMs?: number;
}

/** Trusted runtime-side half of the bridge. Client code never sees this object. */
export class ChildBridge {
  readonly token: string;
  private readonly window: Window;
  private readonly parent: Window;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private sequence = 0;
  private destroyed = false;

  constructor(options: ChildBridgeOptions) {
    this.window = options.window;
    this.parent = options.parent;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
  }

  sendHello(): void {
    this.post({
      channel: CLIENT_BRIDGE_CHANNEL,
      protocol: CLIENT_BRIDGE_PROTOCOL,
      kind: "hello",
      token: this.token,
    });
  }

  request(method: ClientBridgeMethod, params: readonly unknown[] = []): Promise<JsonValue> {
    if (this.destroyed) return Promise.reject(new Error("client bridge is destroyed"));
    if (!isClientBridgeMethod(method)) {
      return Promise.reject(new Error(`unknown bridge method ${method}`));
    }
    const id = this.nextId();
    const jsonParams = toBridgeJson([...params]) as JsonValue[];
    const message: BridgeRequest = {
      channel: CLIENT_BRIDGE_CHANNEL,
      protocol: CLIENT_BRIDGE_PROTOCOL,
      kind: "request",
      token: this.token,
      id,
      method,
      params: jsonParams,
    };
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.postCancel(id);
        reject(
          Object.assign(new Error(`host request ${method} timed out after ${this.timeoutMs}ms`), {
            code: "bridge.timeout",
          }),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.post(message);
    });
  }

  handleMessage(event: Pick<MessageEvent, "data" | "source">): boolean {
    if (event.source !== this.parent) return false;
    const data = event.data as unknown;
    if (!isBridgeEnvelope(data) || data.token !== this.token) return false;
    if (data.kind === "response") {
      const message = data as BridgeResponse;
      const pending = this.pending.get(message.id);
      if (!pending) return true;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result ?? null);
      else pending.reject(deserializeError(message.error ?? { name: "Error", message: "bridge error" }));
      return true;
    }
    if (data.kind === "cancel") {
      const message = data as unknown as { id: string };
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.reject(Object.assign(new Error("request cancelled by the host"), { code: "bridge.cancelled" }));
      }
      return true;
    }
    return false;
  }

  postMounted(height: number): void {
    const message: BridgeMounted = {
      channel: CLIENT_BRIDGE_CHANNEL,
      protocol: CLIENT_BRIDGE_PROTOCOL,
      kind: "mounted",
      token: this.token,
      height,
    };
    this.post(message);
  }

  postResize(height: number): void {
    const message: BridgeResize = {
      channel: CLIENT_BRIDGE_CHANNEL,
      protocol: CLIENT_BRIDGE_PROTOCOL,
      kind: "resize",
      token: this.token,
      height,
    };
    this.post(message);
  }

  postError(error: unknown, phase: BridgeError["phase"]): void {
    const message: BridgeError = {
      channel: CLIENT_BRIDGE_CHANNEL,
      protocol: CLIENT_BRIDGE_PROTOCOL,
      kind: "error",
      token: this.token,
      error: serializeError(error),
      phase,
    };
    this.post(message);
  }

  cancel(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    this.postCancel(id);
    pending.reject(Object.assign(new Error("request cancelled"), { code: "bridge.cancelled" }));
  }

  destroy(): void {
    this.destroyed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error("client bridge was destroyed"), { code: "bridge.destroyed" }));
    }
    this.pending.clear();
  }

  private post(message: unknown): void {
    // The iframe is sandboxed without allow-same-origin, so its origin is
    // opaque ("null") and cannot be used as a targetOrigin. The host checks
    // event.source plus the per-mount token instead.
    this.parent.postMessage(message, "*");
  }

  private postCancel(id: string): void {
    this.post({
      channel: CLIENT_BRIDGE_CHANNEL,
      protocol: CLIENT_BRIDGE_PROTOCOL,
      kind: "cancel",
      token: this.token,
      id,
    });
  }

  private nextId(): string {
    this.sequence += 1;
    const random =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
    return `c${this.sequence}_${random}`;
  }
}

export function createClientApi(bridge: ChildBridge, session: ClientSession): ClientApi {
  const request = (method: ClientBridgeMethod, params: unknown[] = []) =>
    bridge.request(method, params);

  const matchmaker: MatchmakerClient = {
    getPlayer: (userId) =>
      request("matchmaker.getPlayer", [userId]) as unknown as Promise<PlayerStats>,
    getLadder: (input = {}) =>
      request("matchmaker.getLadder", input ? [input] : []) as unknown as Promise<Page<LadderEntry>>,
    getRecentMatches: (userId, limit) =>
      request("matchmaker.getRecentMatches", [userId, limit ?? null]) as unknown as Promise<RecentMatch[]>,
  };

  const roster: RosterClient = {
    listContracts: () => request("roster.listContracts") as unknown as Promise<RosterContract[]>,
    getContract: (handle) =>
      request("roster.getContract", [handle]) as unknown as Promise<RosterContract | undefined>,
    getStorage: (handle) =>
      request("roster.getStorage", [handle]) as unknown as Promise<Record<string, unknown>>,
    call: (handle, endpoint, input) =>
      request("roster.call", [handle, endpoint, input ?? null]) as unknown as Promise<JsonValue>,
  };

  const catalog: CatalogClient = {
    getPiece: (id) => request("catalog.getPiece", [id]) as unknown as Promise<Piece | undefined>,
    searchPieces: (query, limit) =>
      request("catalog.searchPieces", [query, limit ?? null]) as unknown as Promise<Piece[]>,
    getUser: (id) => request("catalog.getUser", [id]) as unknown as Promise<UserSummary | undefined>,
    searchUsers: (query, limit) =>
      request("catalog.searchUsers", [query, limit ?? null]) as unknown as Promise<UserSummary[]>,
  };

  const host: ClientHost = {
    session,
    matchmaker,
    roster,
    catalog,
    confirm: (input: ConfirmInput) => request("confirm", [input]) as unknown as Promise<boolean>,
  };
  return host;
}

export interface MountedClient {
  root: HTMLElement;
  element: HTMLElement;
  destroy(): void;
}

export interface MountClientOptions {
  factory: ClientFactory;
  api: ClientApi;
  window: Window;
  document: Document;
  rootId?: string;
  onError?: (error: unknown) => void;
}

/** Mount the factory's returned DOM node and report size/errors to the host. */
export async function mountClient(options: MountClientOptions): Promise<MountedClient> {
  const rootId = options.rootId ?? "roster-client-root";
  let root = options.document.getElementById(rootId);
  if (!root) {
    root = options.document.createElement("div");
    root.id = rootId;
    options.document.body.appendChild(root);
  }
  const element = await options.factory(options.api);
  if (!element || typeof element !== "object" || (element as Node).nodeType !== 1) {
    throw new TypeError("createClient(api) must return a DOM HTMLElement");
  }
  root.appendChild(element);

  let resizeObserver: ResizeObserver | undefined;
  const reportSize = () => {
    const height = Math.max(
      element.getBoundingClientRect?.().height ?? 0,
      element.scrollHeight ?? 0,
      0,
    );
    return Math.ceil(height);
  };
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => {
      const height = reportSize();
      if (height > 0) bridgeFor(options).postResize(height);
    });
    resizeObserver.observe(element);
  }
  const onWindowResize = () => {
    const height = reportSize();
    if (height > 0) bridgeFor(options).postResize(height);
  };
  options.window.addEventListener("resize", onWindowResize);
  const onError = (event: ErrorEvent) => {
    options.onError?.(event.error ?? event.message);
    bridgeFor(options).postError(event.error ?? event.message, "runtime");
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    options.onError?.(event.reason);
    bridgeFor(options).postError(event.reason, "runtime");
  };
  options.window.addEventListener("error", onError);
  options.window.addEventListener("unhandledrejection", onRejection);

  const height = reportSize();
  bridgeFor(options).postMounted(height);

  return {
    root,
    element,
    destroy() {
      resizeObserver?.disconnect();
      options.window.removeEventListener("resize", onWindowResize);
      options.window.removeEventListener("error", onError);
      options.window.removeEventListener("unhandledrejection", onRejection);
      element.remove();
    },
  };
}

/**
 * The bridge used by mountClient for resize/error reports. It is attached to
 * the API object as a non-enumerable symbol so client code cannot enumerate it
 * (client code already came from the same frame, but keeping it out of the API
 * shape avoids accidental use).
 */
const BRIDGE_SYMBOL: unique symbol = Symbol("roster-client-bridge");
type ApiWithBridge = ClientApi & { [BRIDGE_SYMBOL]?: ChildBridge };

export function attachBridge<T extends ClientApi>(api: T, bridge: ChildBridge): T {
  Object.defineProperty(api, BRIDGE_SYMBOL, {
    value: bridge,
    enumerable: false,
    configurable: false,
  });
  return api;
}

function bridgeFor(options: MountClientOptions): ChildBridge {
  const bridge = (options.api as ApiWithBridge)[BRIDGE_SYMBOL];
  if (!bridge) throw new Error("client API is not attached to a bridge");
  return bridge;
}

export interface InstallClientRuntimeOptions {
  window?: Window;
  document?: Document;
  token?: string;
  rootId?: string;
  factory?: ClientFactory | { default?: ClientFactory };
  readyTimeoutMs?: number;
}

/**
 * Entrypoint compiled into the static runtime script. It reads its own script
 * tag, sends `hello`, waits for the host's `init`, then mounts the client.
 */
export async function installClientRuntime(
  options: InstallClientRuntimeOptions = {},
): Promise<MountedClient> {
  const windowRef = options.window ?? globalThis.window;
  const documentRef = options.document ?? windowRef.document;
  const script = documentRef.currentScript as HTMLScriptElement | null;
  const rootId = options.rootId ?? script?.dataset.root ?? "roster-client-root";
  const token = options.token ?? tokenFromLocationHash(windowRef.location.hash);
  if (!token) throw new Error("client runtime is missing its bridge token");
  const factory = resolveFactory(
    options.factory ??
      (windowRef as unknown as { __rosterClientFactory?: unknown }).__rosterClientFactory,
  );
  const bridge = new ChildBridge({
    window: windowRef,
    parent: windowRef.parent,
    token,
    timeoutMs: DEFAULT_BRIDGE_TIMEOUT_MS,
  });

  return new Promise<MountedClient>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      windowRef.removeEventListener("message", onMessage);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      bridge.postError(error, "load");
      bridge.destroy();
      reject(error);
    };
    const onMessage = async (event: MessageEvent) => {
      if (event.source !== windowRef.parent) return;
      if (bridge.handleMessage(event)) return;
      if (!isBridgeEnvelope(event.data) || event.data.token !== token) return;
      if (event.data.kind !== "init" || settled) return;
      settled = true;
      cleanup();
      const init = event.data as BridgeInit;
      try {
        const api = attachBridge(createClientApi(bridge, init.session), bridge);
        const mounted = await mountClient({
          factory,
          api,
          window: windowRef,
          document: documentRef,
          rootId,
          onError: (error) => bridge.postError(error, "runtime"),
        });
        resolve({
          ...mounted,
          destroy() {
            mounted.destroy();
            bridge.destroy();
          },
        });
      } catch (error) {
        bridge.postError(error, "mount");
        bridge.destroy();
        reject(error);
      }
    };
    windowRef.addEventListener("message", onMessage);
    bridge.sendHello();
    const timer = setTimeout(() => fail(new Error("timed out waiting for the host client init")), options.readyTimeoutMs ?? 10_000);
    if (timer && typeof timer === "object" && "unref" in timer) {
      (timer as { unref?: () => void }).unref?.();
    }
  });
}

function resolveFactory(value: unknown): ClientFactory {
  if (typeof value === "function") return value as ClientFactory;
  if (value && typeof value === "object" && typeof (value as { default?: unknown }).default === "function") {
    return (value as { default: ClientFactory }).default;
  }
  throw new Error("the client bundle did not define a default createClient factory");
}
