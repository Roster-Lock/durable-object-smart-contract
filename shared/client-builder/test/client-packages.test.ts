import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MemoryContentCache,
  NpmPackageProvider,
  PackageError,
  createNpmTarball,
} from "@roster-lock/smart-contract-client-builder";

function integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function fakeRegistry(packages: Record<string, { tarball: Uint8Array; metadata: Record<string, unknown> }>) {
  const counts = new Map<string, number>();
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    counts.set(url, (counts.get(url) ?? 0) + 1);
    const name = url.endsWith(".tgz")
      ? decodeURIComponent(url.split("/").slice(-3)[0] ?? "")
      : decodeURIComponent(url.split("/").pop() ?? "");
    const entry = packages[name];
    if (!entry) return new Response("not found", { status: 404 });
    if (url.endsWith(".tgz")) {
      return new Response(entry.tarball as unknown as BodyInit, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    return new Response(
      JSON.stringify({
        name,
        versions: { "1.0.0": entry.metadata },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetchImpl, counts };
}

function packageTarball(name: string, files: Record<string, string>, extra: Record<string, unknown> = {}) {
  return createNpmTarball([
    {
      path: "package.json",
      data: JSON.stringify({ name, version: "1.0.0", main: "index.js", ...extra }),
    },
    ...Object.entries(files).map(([path, data]) => ({ path, data })),
  ]);
}

describe("build-time npm package resolution", () => {
  it("fetches on demand and reuses the content-addressed tarball cache", async () => {
    const tarball = packageTarball("tiny", {
      "index.js": "export const value = 42;",
    });
    const registry = fakeRegistry({
      tiny: {
        tarball,
        metadata: {
          name: "tiny",
          version: "1.0.0",
          main: "index.js",
          dist: { tarball: "https://registry.test/tiny/-/tiny-1.0.0.tgz", integrity: integrity(tarball) },
        },
      },
    });
    const cache = new MemoryContentCache();
    const provider = new NpmPackageProvider({
      registryUrl: "https://registry.test",
      fetchImpl: registry.fetchImpl,
      cache,
    });

    const first = await provider.resolve("tiny", "^1.0.0");
    const second = await provider.resolve("tiny", "1.0.0");
    expect(first.version).toBe("1.0.0");
    expect(second.files.get("index.js")).toBeDefined();
    const tarballFetches = [...registry.counts.entries()].filter(([url]) => url.endsWith(".tgz"));
    expect(tarballFetches).toHaveLength(1);
    expect(cache.size).toBeGreaterThan(0);
    expect(first.tarballHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects lifecycle scripts and native addons instead of executing them", async () => {
    const lifecycleTarball = packageTarball(
      "lifecycle",
      { "index.js": "export default 1;" },
      { scripts: { postinstall: "node install.js" } },
    );
    const nativeTarball = packageTarball("native", { "index.node": "ELF" });
    const registry = fakeRegistry({
      lifecycle: {
        tarball: lifecycleTarball,
        metadata: {
          name: "lifecycle",
          version: "1.0.0",
          main: "index.js",
          scripts: { postinstall: "node install.js" },
          dist: {
            tarball: "https://registry.test/lifecycle/-/lifecycle-1.0.0.tgz",
            integrity: integrity(lifecycleTarball),
          },
        },
      },
      native: {
        tarball: nativeTarball,
        metadata: {
          name: "native",
          version: "1.0.0",
          main: "index.node",
          gypfile: true,
          dist: {
            tarball: "https://registry.test/native/-/native-1.0.0.tgz",
            integrity: integrity(nativeTarball),
          },
        },
      },
    });
    const provider = new NpmPackageProvider({
      registryUrl: "https://registry.test",
      fetchImpl: registry.fetchImpl,
      cache: new MemoryContentCache(),
    });

    await expect(provider.resolve("lifecycle", "1.0.0")).rejects.toMatchObject({
      code: "package.lifecycle_script",
    });
    await expect(provider.resolve("native", "1.0.0")).rejects.toMatchObject({
      code: "package.native_addon",
    });
    await expect(provider.resolve("missing", "1.0.0")).rejects.toBeInstanceOf(PackageError);
  });

  it("verifies registry integrity", async () => {
    const tarball = packageTarball("bad", { "index.js": "export default 1;" });
    const registry = fakeRegistry({
      bad: {
        tarball,
        metadata: {
          name: "bad",
          version: "1.0.0",
          main: "index.js",
          dist: {
            tarball: "https://registry.test/bad/-/bad-1.0.0.tgz",
            integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
          },
        },
      },
    });
    const provider = new NpmPackageProvider({
      registryUrl: "https://registry.test",
      fetchImpl: registry.fetchImpl,
      cache: new MemoryContentCache(),
    });
    await expect(provider.resolve("bad", "1.0.0")).rejects.toMatchObject({
      code: "package.integrity",
    });
  });
});
