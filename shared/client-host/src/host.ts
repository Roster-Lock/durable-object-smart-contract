import type { ClientHost, ConfirmInput } from "@roster-lock/smart-contract-sdk";
import {
  assertPinnedBuild,
  assertSeparateOrigin,
  CLIENT_IFRAME_SANDBOX,
} from "./csp.js";
import {
  CLIENT_BRIDGE_CHANNEL,
  CLIENT_BRIDGE_METHODS,
  CLIENT_BRIDGE_PROTOCOL,
  DEFAULT_BRIDGE_TIMEOUT_MS,
  MAX_BRIDGE_MESSAGE_BYTES,
  MAX_CONFIRM_MESSAGE_LENGTH,
  assertBridgeMessageSize,
  bridgeTokenForDocument,
  isBridgeEnvelope,
  isClientBridgeMethod,
  serializeError,
  toBridgeJson,
  type BridgeInit,
  type BridgeRequest,
  type BridgeResponse,
  type ClientBridgeMethod,
  type JsonValue,
} from "./protocol.js";

const MAX_PENDING = 64;

export interface HostBridgeDispatcherOptions {
  api: ClientHost;
  /** Host-owned confirmation UI; defaults to api.confirm. */
  confirm?: (input: ConfirmInput) => Promise<boolean>;
  token: string;
  expectedSource: () => Window | null;
  /** Sandboxed iframes have an opaque origin, which browsers report as "null". */
  expectedOrigin?: string;
  post: (message: unknown) => void;
  timeoutMs?: number;
  maxRequestBytes?: number;
  onTimeout?: (method: ClientBridgeMethod) => void;
  onError?: (error: unknown, method: ClientBridgeMethod) => void;
}

/**
 * Host half of the bridge. Every method is an explicit allowlist entry with
 * argument checks; the result and params are JSON-only.
 */
export class HostBridgeDispatcher {
  private readonly pending = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; method: ClientBridgeMethod }
  >();
  private destroyed = false;

  constructor(private readonly options: HostBridgeDispatcherOptions) {}

  get methods(): readonly ClientBridgeMethod[] {
    return CLIENT_BRIDGE_METHODS;
  }

  /** Returns true when the message belongs to this dispatcher. */
  handleMessage(event: Pick<MessageEvent, "data" | "source" | "origin">): boolean {
    if (this.destroyed) return false;
    if (event.source !== this.options.expectedSource()) return false;
    if (this.options.expectedOrigin !== undefined && event.origin !== this.options.expectedOrigin) return false;
    const data = event.data as unknown;
    if (!isBridgeEnvelope(data) || data.token !== this.options.token) return false;
    if (data.kind === "cancel") {
      const cancel = data as unknown as { id?: unknown };
      if (typeof cancel.id === "string") this.cancel(cancel.id);
      return true;
    }
    if (data.kind !== "request") return false;
    const request = data as BridgeRequest;
    try {
      assertBridgeMessageSize(request);
    } catch (error) {
      this.respondError(request.id, error, "bridge.message_size");
      return true;
    }
    if (typeof request.id !== "string" || request.id.length === 0 || request.id.length > 128) {
      this.respondError(request.id, new Error("invalid bridge request id"), "bridge.request_id");
      return true;
    }
    if (!isClientBridgeMethod(request.method) || !Array.isArray(request.params)) {
      this.respondError(request.id, new Error("invalid bridge request"), "bridge.request");
      return true;
    }
    if (this.pending.has(request.id)) {
      this.respondError(request.id, new Error("duplicate bridge request id"), "bridge.duplicate_id");
      return true;
    }
    if (this.pending.size >= MAX_PENDING) {
      this.respondError(request.id, new Error("too many in-flight host requests"), "bridge.busy");
      return true;
    }
    let bytes = 0;
    try {
      bytes =
        request.params.length > 0
          ? new TextEncoder().encode(JSON.stringify(request.params)).byteLength
          : 0;
    } catch {
      this.respondError(request.id, new Error("bridge params are not JSON"), "bridge.params_invalid");
      return true;
    }
    if (bytes > (this.options.maxRequestBytes ?? MAX_BRIDGE_MESSAGE_BYTES)) {
      this.respondError(request.id, new Error("bridge request params are too large"), "bridge.params_too_large");
      return true;
    }
    const timer = setTimeout(() => {
      this.pending.delete(request.id);
      this.options.onTimeout?.(request.method);
      this.respondError(
        request.id,
        Object.assign(new Error(`host request ${request.method} timed out`), {
          code: "bridge.timeout",
        }),
        "bridge.timeout",
      );
      this.post({
        channel: CLIENT_BRIDGE_CHANNEL,
        protocol: CLIENT_BRIDGE_PROTOCOL,
        kind: "cancel",
        token: this.options.token,
        id: request.id,
      });
    }, this.options.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS);
    this.pending.set(request.id, { timer, method: request.method });
    void this.dispatch(request).finally(() => {
      const current = this.pending.get(request.id);
      if (current) {
        clearTimeout(current.timer);
        this.pending.delete(request.id);
      }
    });
    return true;
  }

  cancel(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    this.post({
      channel: CLIENT_BRIDGE_CHANNEL,
      protocol: CLIENT_BRIDGE_PROTOCOL,
      kind: "cancel",
      token: this.options.token,
      id,
    });
  }

  destroy(): void {
    this.destroyed = true;
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
  }

  private async dispatch(request: BridgeRequest): Promise<void> {
    try {
      const result = await this.invoke(request.method, request.params);
      this.respond(request.id, result);
    } catch (error) {
      this.options.onError?.(error, request.method);
      this.respondError(request.id, error, "host.error");
    }
  }

  private async invoke(method: ClientBridgeMethod, params: JsonValue[]): Promise<JsonValue> {
    const api = this.options.api;
    switch (method) {
      case "matchmaker.getPlayer":
        return toBridgeJson(await api.matchmaker.getPlayer(stringArg(params, 0, "userId")));
      case "matchmaker.getLadder": {
        const input = optionalLadderInput(params[0]);
        return toBridgeJson(await api.matchmaker.getLadder(input));
      }
      case "matchmaker.getRecentMatches": {
        const userId = stringArg(params, 0, "userId");
        const limit = optionalInteger(params[1], "limit");
        return toBridgeJson(
          await api.matchmaker.getRecentMatches(userId, limit),
        );
      }
      case "roster.listContracts":
        return toBridgeJson(stripContractIds(await api.roster.listContracts()));
      case "roster.getContract":
        return toBridgeJson(
          stripContractId(await api.roster.getContract(stringArg(params, 0, "handle"))),
        );
      case "roster.getStorage":
        return toBridgeJson(await api.roster.getStorage(stringArg(params, 0, "handle")));
      case "roster.call": {
        const handle = stringArg(params, 0, "handle");
        const endpoint = stringArg(params, 1, "endpoint");
        const input = params[2] ?? null;
        return toBridgeJson(await api.roster.call(handle, endpoint, input));
      }
      case "catalog.getPiece":
        return toBridgeJson(await api.catalog.getPiece(stringArg(params, 0, "pieceId")));
      case "catalog.searchPieces":
        return toBridgeJson(
          await api.catalog.searchPieces(
            stringArg(params, 0, "query"),
            optionalInteger(params[1], "limit"),
          ),
        );
      case "catalog.getUser":
        return toBridgeJson(await api.catalog.getUser(stringArg(params, 0, "userId")));
      case "catalog.searchUsers":
        return toBridgeJson(
          await api.catalog.searchUsers(
            stringArg(params, 0, "query"),
            optionalInteger(params[1], "limit"),
          ),
        );
      case "confirm": {
        const input = confirmInput(params[0]);
        const confirm = this.options.confirm ?? api.confirm;
        return await confirm(input);
      }
      default:
        throw Object.assign(new Error(`unknown client bridge method ${method}`), {
          code: "host.unknown_method",
        });
    }
  }

  private respond(id: string, result: JsonValue): void {
    const message: BridgeResponse = {
      channel: CLIENT_BRIDGE_CHANNEL,
      protocol: CLIENT_BRIDGE_PROTOCOL,
      kind: "response",
      token: this.options.token,
      id,
      ok: true,
      result,
    };
    this.post(message);
  }

  private respondError(id: string, error: unknown, code: string): void {
    const serialized = serializeError(error);
    const message: BridgeResponse = {
      channel: CLIENT_BRIDGE_CHANNEL,
      protocol: CLIENT_BRIDGE_PROTOCOL,
      kind: "response",
      token: this.options.token,
      id: typeof id === "string" ? id : "invalid",
      ok: false,
      error: { ...serialized, code: serialized.code ?? code },
    };
    this.post(message);
  }

  private post(message: unknown): void {
    this.options.post(message);
  }
}

function stripContractIds<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripContractId(item)) as unknown as T;
  return stripContractId(value);
}

function stripContractId<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const object = value as Record<string, unknown>;
  if (!("handle" in object) || !("id" in object)) return value;
  const { id: _id, ...rest } = object;
  return rest as T;
}

function stringArg(params: JsonValue[], index: number, name: string): string {
  const value = params[index];
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw Object.assign(new Error(`${name} must be a non-empty string`), {
      code: "host.invalid_argument",
    });
  }
  return value;
}

function optionalInteger(value: JsonValue | undefined, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10_000) {
    throw Object.assign(new Error(`${name} must be a non-negative integer`), {
      code: "host.invalid_argument",
    });
  }
  return value;
}

function optionalLadderInput(value: JsonValue | undefined): { limit?: number; cursor?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("ladder input must be an object"), {
      code: "host.invalid_argument",
    });
  }
  const object = value as Record<string, JsonValue>;
  const limit = optionalInteger(object.limit, "limit");
  const cursor = object.cursor;
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 512)) {
    throw Object.assign(new Error("cursor must be a string"), { code: "host.invalid_argument" });
  }
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(typeof cursor === "string" ? { cursor } : {}),
  };
}

function confirmInput(value: JsonValue | undefined): ConfirmInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("confirm input must be an object"), {
      code: "host.invalid_argument",
    });
  }
  const object = value as Record<string, JsonValue>;
  if (typeof object.title !== "string" || typeof object.message !== "string") {
    throw Object.assign(new Error("confirm title and message are required"), {
      code: "host.invalid_argument",
    });
  }
  if (object.title.length === 0 || object.message.length === 0) {
    throw Object.assign(new Error("confirm title and message may not be empty"), {
      code: "host.invalid_argument",
    });
  }
  if (object.title.length > 200 || object.message.length > MAX_CONFIRM_MESSAGE_LENGTH) {
    throw Object.assign(new Error("confirm text is too long"), {
      code: "host.invalid_argument",
    });
  }
  return {
    title: object.title,
    message: object.message,
    ...(object.details !== undefined ? { details: object.details } : {}),
  };
}

export interface ClientFrameHostOptions {
  iframe: HTMLIFrameElement;
  window: Window;
  api: ClientHost;
  confirm?: (input: ConfirmInput) => Promise<boolean>;
  /** Immutable artifact document URL on the client-artifact origin. */
  documentUrl: string;
  token?: string;
  expectedBuild?: { buildId: string; sourceHash?: string; bundleHash?: string };
  allowSameOrigin?: boolean;
  /** Default "null" because the iframe is sandboxed without same-origin. */
  expectedClientOrigin?: string;
  timeoutMs?: number;
  startTimeoutMs?: number;
  initialHeight?: number;
  onReady?: (height: number) => void;
  onResize?: (height: number) => void;
  onError?: (error: Error, phase: string) => void;
}

/**
 * Sandboxed iframe host. The iframe has no allow-same-origin, so the bundle
 * cannot read host cookies/DOM/storage. postMessage uses "*" because the
 * iframe origin is opaque; event.source + token are the checks.
 */
export class ClientFrameHost {
  readonly token: string;
  private dispatcher?: HostBridgeDispatcher;
  private readonly iframe: HTMLIFrameElement;
  private readonly window: Window;
  private readonly options: ClientFrameHostOptions;
  private started = false;
  private ready = false;
  private destroyed = false;
  private startPromise?: Promise<number>;
  private resolveStart?: (height: number) => void;
  private rejectStart?: (error: Error) => void;
  private startTimer?: ReturnType<typeof setTimeout>;
  private onMessage?: (event: MessageEvent) => void;

  constructor(options: ClientFrameHostOptions) {
    this.options = options;
    this.iframe = options.iframe;
    this.window = options.window;
    this.token = options.token ?? bridgeTokenForDocument();
  }

  start(): Promise<number> {
    if (this.started) return this.startPromise ?? Promise.resolve(this.options.initialHeight ?? 0);
    this.started = true;
    const url = assertSeparateOrigin(
      this.options.documentUrl,
      this.window.location.origin,
      this.options.allowSameOrigin,
    );
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("the client document must be an http(s) URL");
    }
    if (this.options.expectedBuild) {
      assertPinnedBuild(this.options.documentUrl, this.options.expectedBuild);
    }
    this.iframe.setAttribute("sandbox", CLIENT_IFRAME_SANDBOX);
    this.iframe.setAttribute("referrerpolicy", "no-referrer");
    this.iframe.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'");
    this.iframe.style.width = "100%";
    this.iframe.style.border = "0";
    this.iframe.style.height = `${this.options.initialHeight ?? 0}px`;

    this.dispatcher = new HostBridgeDispatcher({
      api: this.options.api,
      ...(this.options.confirm ? { confirm: this.options.confirm } : {}),
      token: this.token,
      expectedSource: () => this.iframe.contentWindow,
      expectedOrigin: this.options.expectedClientOrigin ?? "null",
      post: (message) => this.post(message),
      timeoutMs: this.options.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS,
      onTimeout: (method) =>
        this.options.onError?.(
          Object.assign(new Error(`host request ${method} timed out`), { code: "bridge.timeout" }),
          "timeout",
        ),
      onError: (error, method) =>
        this.options.onError?.(
          error instanceof Error ? error : new Error(String(error)),
          `host:${method}`,
        ),
    });

    this.startPromise = new Promise<number>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
    this.startTimer = setTimeout(() => {
      this.fail(new Error("timed out waiting for the client iframe to mount"), "start");
    }, this.options.startTimeoutMs ?? 15_000);

    this.onMessage = (event: MessageEvent) => this.handleMessage(event);
    this.window.addEventListener("message", this.onMessage);
    const hash = new URLSearchParams({ "roster-token": this.token }).toString();
    this.iframe.src = `${url.toString().split("#")[0]}#${hash}`;
    return this.startPromise;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.onMessage) this.window.removeEventListener("message", this.onMessage);
    this.dispatcher?.destroy();
    this.rejectStart?.(new Error("client frame was destroyed"));
    this.rejectStart = undefined;
    try {
      this.iframe.src = "about:blank";
    } catch {
      // Detached iframe in tests.
    }
  }

  private handleMessage(event: MessageEvent): void {
    if (this.destroyed) return;
    if (event.source !== this.iframe.contentWindow) return;
    if (event.origin !== (this.options.expectedClientOrigin ?? "null")) return;
    const data = event.data as unknown;
    if (!isBridgeEnvelope(data) || data.token !== this.token) return;
    if (data.kind === "hello") {
      this.sendInit();
      return;
    }
    if (data.kind === "mounted") {
      const height = safeHeight((data as { height?: unknown }).height);
      this.applyHeight(height);
      if (!this.ready) {
        this.ready = true;
        if (this.startTimer) clearTimeout(this.startTimer);
        this.options.onReady?.(height);
        this.resolveStart?.(height);
      }
      return;
    }
    if (data.kind === "resize") {
      const height = safeHeight((data as { height?: unknown }).height);
      this.applyHeight(height);
      this.options.onResize?.(height);
      return;
    }
    if (data.kind === "error") {
      const error = new Error(
        (data as { error?: { message?: string } }).error?.message ?? "client runtime error",
      );
      const phase = (data as { phase?: string }).phase ?? "runtime";
      if (!this.ready) this.fail(error, phase);
      else this.options.onError?.(error, phase);
      return;
    }
    if (data.kind === "request" || data.kind === "cancel") {
      this.dispatcher?.handleMessage(event);
      return;
    }
  }

  private sendInit(): void {
    const message: BridgeInit = {
      channel: CLIENT_BRIDGE_CHANNEL,
      protocol: CLIENT_BRIDGE_PROTOCOL,
      kind: "init",
      token: this.token,
      session: this.options.api.session,
      methods: CLIENT_BRIDGE_METHODS,
      timeoutMs: this.options.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS,
    };
    this.post(message);
  }

  private post(message: unknown): void {
    const target = this.iframe.contentWindow;
    if (!target) return;
    // Opaque iframe origin: targetOrigin "*", with source + token checks.
    target.postMessage(message, "*");
  }

  private applyHeight(height: number): void {
    this.iframe.style.height = `${height}px`;
  }

  private fail(error: Error, phase: string): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.options.onError?.(error, phase);
    this.rejectStart?.(error);
    this.rejectStart = undefined;
    this.resolveStart = undefined;
  }
}

function safeHeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.ceil(value), 0), 100_000);
}
