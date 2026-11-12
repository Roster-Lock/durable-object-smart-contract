import { readFileSync } from "node:fs";
import { join } from "node:path";
import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten";
import { describe, expect, it } from "vitest";
import { ContractService } from "../src/contract.js";
import { SandboxRuntime } from "../src/runtime/sandbox.js";
import { freshTestDatabase } from "@roster-lock/smart-contract-test-client";

/**
 * Production passes the compiled wasm in from a `[[wasm_modules]]` binding,
 * because workerd cannot fetch the package's wasm from a relative URL. This
 * covers that wiring without needing workerd, by compiling the same file.
 */
describe("custom QuickJS wasm module", () => {
  it("runs a contract through an injected WebAssembly.Module", async () => {
    const compiler = WebAssembly as unknown as {
      compile(bytes: Uint8Array): Promise<WebAssembly.Module>;
    };
    const wasm = await compiler.compile(
      readFileSync(
        join(
          process.cwd(),
          "node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm",
        ),
      ),
    );

    const runtime = new SandboxRuntime(() =>
      newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmModule: wasm })),
    );
    const db = await freshTestDatabase();
    const service = new ContractService({
      contractId: "wasm",
      openDb: db.open,
      runtime,
      config: { gasPricePerMillion: 0 },
    });
    await service.initialize();
    await service.deploy({
      ownerId: "alice",
      name: "wasm",
      version: "1",
      source: `defineContract({ endpoints: { ping: { run: async () => "pong" } } });`,
    });
    const result = await service.call({ callerId: "bob", endpoint: "ping" });
    expect(result.result).toBe("pong");
    expect(result.gasCharged).toBe(0);
  });
});
