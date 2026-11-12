import { describe, expect, it } from "vitest";
import {
  ChildBridge,
  ClientFrameHost,
  HostBridgeDispatcher,
  attachBridge,
  createClientApi,
  createClientCsp,
  createClientDocument,
  createClientFrameHeaders,
  createMatchmakerClient,
  createRecentMatchesAdapter,
  assertSeparateOrigin,
  mountClient,
  type JsonValue,
} from "@roster-lock/smart-contract-client-host";
import { createFakeClientHost } from "@roster-lock/smart-contract-client-host/fake";

type Listener = (event: MessageEvent) => void;

class FakeWindow {
  readonly listeners = new Map<string, Set<Listener>>();
  parent: FakeWindow | undefined;
  target: FakeWindow | undefined;
  readonly location: { origin: string; hash: string };
  readonly origin: string;
  constructor(origin: string, hash = "") {
    this.origin = origin;
    this.location = { origin, hash };
  }
  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }
  postMessage(data: unknown): void {
    const source = this.target ?? this;
    this.dispatch({ data, source, origin: source.origin });
  }
  dispatch(event: { data: unknown; source: FakeWindow; origin: string }): void {
    const message = event as unknown as MessageEvent;
    for (const listener of [...(this.listeners.get("message") ?? [])]) listener(message);
  }
}

function link(host: FakeWindow, child: FakeWindow): void {
  host.target = child;
  child.target = host;
  child.parent = host;
}

describe("client iframe bridge", () => {
  it("serves confirm through the host and serializes results", async () => {
    const hostWindow = new FakeWindow("https://host.test");
    const childWindow = new FakeWindow("https://client.test");
    link(hostWindow, childWindow);
    const token = "token-1";
    const bridge = new ChildBridge({
      window: childWindow as unknown as Window,
      parent: hostWindow as unknown as Window,
      token,
    });
    childWindow.addEventListener("message", (event) => bridge.handleMessage(event));
    const fake = createFakeClientHost({
      session: { userId: "alice" },
      contracts: [
        {
          id: "internal-contract-id",
          handle: "living-roster",
          name: "Living roster",
          endpoints: {},
        },
      ],
    });
    const dispatcher = new HostBridgeDispatcher({
      api: fake.host,
      confirm: async (input) => {
        fake.confirmations.push(input);
        return false;
      },
      token,
      expectedSource: () => childWindow as unknown as Window,
      post: (message) => {
        childWindow.dispatch({ data: message, source: hostWindow, origin: hostWindow.origin });
      },
    });
    hostWindow.addEventListener("message", (event) => dispatcher.handleMessage(event));

    const api = createClientApi(bridge, { userId: "alice" });
    const accepted = await api.confirm({ title: "Submit", message: "Pay gas?" });
    expect(accepted).toBe(false);
    expect(fake.confirmations).toHaveLength(1);
    expect(fake.confirmations[0]?.title).toBe("Submit");

    const player = await api.matchmaker.getPlayer("alice");
    expect(player.userId).toBe("alice");
    expect(player.mmr).toBe(1000);

    const contracts = await api.roster.listContracts();
    expect(contracts[0]?.handle).toBe("living-roster");
    expect(contracts[0]?.id).toBeUndefined();
    dispatcher.destroy();
    bridge.destroy();
  });

  it("rejects functions at the bridge and times out host calls", async () => {
    const hostWindow = new FakeWindow("https://host.test");
    const childWindow = new FakeWindow("https://client.test");
    link(hostWindow, childWindow);
    const token = "token-2";
    const bridge = new ChildBridge({
      window: childWindow as unknown as Window,
      parent: hostWindow as unknown as Window,
      token,
      timeoutMs: 1_000,
    });
    childWindow.addEventListener("message", (event) => bridge.handleMessage(event));
    const fake = createFakeClientHost();
    const dispatcher = new HostBridgeDispatcher({
      api: fake.host,
      token,
      timeoutMs: 20,
      expectedSource: () => childWindow as unknown as Window,
      post: (message) => {
        childWindow.dispatch({ data: message, source: hostWindow, origin: hostWindow.origin });
      },
      confirm: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return true;
      },
    });
    hostWindow.addEventListener("message", (event) => dispatcher.handleMessage(event));
    const api = createClientApi(bridge, {});

    expect(() =>
      api.confirm({ title: "x", message: "y", details: (() => 1) as unknown as JsonValue }),
    ).toThrow(TypeError);

    await expect(api.confirm({ title: "x", message: "y" })).rejects.toMatchObject({
      code: "bridge.timeout",
    });
    dispatcher.destroy();
    bridge.destroy();
  });

  it("mounts a returned element and reports its size", async () => {
    const hostWindow = new FakeWindow("https://host.test");
    const childWindow = new FakeWindow("https://client.test");
    link(hostWindow, childWindow);
    const token = "token-3";
    const bridge = new ChildBridge({
      window: childWindow as unknown as Window,
      parent: hostWindow as unknown as Window,
      token,
    });
    const messages: Array<Record<string, unknown>> = [];
    hostWindow.addEventListener("message", (event) => {
      messages.push(event.data as Record<string, unknown>);
    });
    const document = new FakeDocument();
    const api = attachBridge(createClientApi(bridge, { userId: "alice" }), bridge);
    const element = document.createElement("div");
    const mounted = await mountClient({
      factory: () => element as unknown as HTMLElement,
      api,
      window: childWindow as unknown as Window,
      document: document as unknown as Document,
    });
    expect(mounted.element).toBe(element);
    expect(mounted.root.contains(element as unknown as Node)).toBe(true);
    expect(messages.some((message) => message.kind === "mounted")).toBe(true);
    mounted.destroy();
    bridge.destroy();
  });

  it("builds a static CSP document with no runtime script injection", () => {
    const csp = createClientCsp();
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("worker-src 'none'");
    expect(csp).toContain("script-src 'self'");
    const html = createClientDocument({
      bundleUrl: "https://client.test/builds/b_1/bundle.js",
      runtimeScriptUrl: "https://client.test/runtime.js",
      styles: ["https://client.test/builds/b_1/assets/x.css"],
      csp,
    });
    expect(html).toContain("https://client.test/builds/b_1/bundle.js");
    expect(html).toContain("https://client.test/runtime.js");
    expect(html).not.toMatch(/<script>[^<]/);
    const headers = createClientFrameHeaders({ csp, hostOrigin: "https://host.test" });
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors https://host.test");
  });

  it("requires a separate origin unless explicitly allowed", () => {
    expect(() =>
      assertSeparateOrigin("https://host.test/client", "https://host.test"),
    ).toThrow(/separate origin/);
    expect(() =>
      assertSeparateOrigin("https://client.test/client", "https://host.test"),
    ).not.toThrow();
  });

  it("starts a sandboxed frame, pins the build and resolves on mount", async () => {
    const hostWindow = new FakeWindow("https://host.test");
    const frame = new FakeIframe();
    const fake = createFakeClientHost();
    const buildId = "b_0123456789abcdef0123456789abcdef";
    const frameHost = new ClientFrameHost({
      iframe: frame as unknown as HTMLIFrameElement,
      window: hostWindow as unknown as Window,
      api: fake.host,
      documentUrl: `https://client.test/client-builds/${buildId}/index.html`,
      expectedBuild: { buildId },
    });
    const started = frameHost.start();
    expect(frame.attributes.get("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame.attributes.get("sandbox")).not.toContain("allow-same-origin");
    expect(frame.src).toContain(buildId);
    expect(frame.src).toContain("#roster-token=");

    const childWindow = new FakeWindow("null");
    frame.contentWindow = childWindow;
    link(hostWindow, childWindow);
    const childBridge = new ChildBridge({
      window: childWindow as unknown as Window,
      parent: hostWindow as unknown as Window,
      token: frameHost.token,
    });
    childWindow.addEventListener("message", (event) => childBridge.handleMessage(event));
    childBridge.sendHello();
    hostWindow.postMessage({
      channel: "roster-lock/client-bridge",
      protocol: 1,
      kind: "mounted",
      token: frameHost.token,
      height: 44,
    });
    await expect(started).resolves.toBe(44);
    expect(frame.style.height).toBe("44px");
    frameHost.destroy();
    childBridge.destroy();
  });

  it("refuses a same-origin client document by default", () => {
    const frame = new FakeIframe();
    const hostWindow = new FakeWindow("https://host.test");
    const frameHost = new ClientFrameHost({
      iframe: frame as unknown as HTMLIFrameElement,
      window: hostWindow as unknown as Window,
      api: createFakeClientHost().host,
      documentUrl: "https://host.test/builds/b_1/index.html",
    });
    expect(() => frameHost.start()).toThrow(/separate origin/);
  });

  it("maps host match history into recent matches and flags a missing ladder", async () => {
    const adapter = createRecentMatchesAdapter({
      listHistory: async () => [
        {
          matchId: "m1",
          finishedAt: 10,
          participants: ["alice", "bob"],
          result: { winners: ["alice"] },
        },
        {
          matchId: "m2",
          finishedAt: 9,
          participants: ["alice", "carl"],
          result: { winners: ["carl"] },
        },
        {
          matchId: "m3",
          finishedAt: 8,
          participants: ["alice", "dave"],
          result: { winners: [] },
        },
      ],
    });
    const recent = await adapter("alice", 10);
    expect(recent.map((match) => match.result)).toEqual(["win", "loss", "draw"]);
    expect(recent[0]?.opponentId).toBe("bob");
    expect(recent[0]?.mmrDelta).toBe(0);

    const matchmaker = createMatchmakerClient({});
    await expect(matchmaker.getLadder()).rejects.toMatchObject({
      code: "host.ladder_unavailable",
    });
  });
});

class FakeIframe {
  contentWindow: FakeWindow | null = null;
  src = "";
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

class FakeElement {
  nodeType = 1;
  id = "";
  style: Record<string, string> = {};
  scrollHeight = 42;
  children: FakeElement[] = [];
  parentNode: FakeElement | undefined;
  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  contains(child: FakeElement): boolean {
    return this.children.includes(child);
  }
  remove(): void {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((item) => item !== this);
    }
  }
  getBoundingClientRect(): { height: number } {
    return { height: this.scrollHeight };
  }
}

class FakeDocument {
  body = new FakeElement();
  currentScript: { dataset: Record<string, string> } | null = null;
  createElement(_tag?: string): FakeElement {
    return new FakeElement();
  }
  getElementById(id: string): FakeElement | null {
    return findId(this.body, id);
  }
}

function findId(root: FakeElement, id: string): FakeElement | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findId(child, id);
    if (found) return found;
  }
  return null;
}
