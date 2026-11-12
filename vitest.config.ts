import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

function pkg(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: {
      "@roster-lock/smart-contract-test-client/client": pkg("./shared/test-client/src/client.ts"),
      "@roster-lock/smart-contract-test-client": pkg("./shared/test-client/src/index.ts"),
      "@roster-lock/smart-contract/validator": pkg("./shared/smart-contract/src/validator.ts"),
      "@roster-lock/smart-contract/builder": pkg("./shared/smart-contract/src/builder.ts"),
      "@roster-lock/smart-contract/postgres": pkg("./shared/smart-contract/src/sql/postgres.ts"),
      "@roster-lock/smart-contract/cloudflare": pkg("./shared/smart-contract/src/durable-object.ts"),
      "@roster-lock/smart-contract": pkg("./shared/smart-contract/src/index.ts"),
      "@roster-lock/living-roster/build": pkg("./living-roster/tools/src/build.ts"),
      "@roster-lock/living-roster-test-client": pkg("./living-roster/test-client/src/index.ts"),
      "@roster-lock/living-roster-cloudflare": pkg("./living-roster/cloudflare/src/index.ts"),
      "@roster-lock/living-roster": pkg("./living-roster/tools/src/index.ts"),
      "@roster-lock/match-making/build": pkg("./match-making/tools/src/build.ts"),
      "@roster-lock/match-making-test-client": pkg("./match-making/test-client/src/index.ts"),
      "@roster-lock/match-making-cloudflare": pkg("./match-making/cloudflare/src/index.ts"),
      "@roster-lock/match-making-client/model": pkg("./match-making/client/src/model.ts"),
      "@roster-lock/match-making-client": pkg("./match-making/client/src/index.ts"),
      "@roster-lock/match-making": pkg("./match-making/tools/src/index.ts"),
      "@roster-lock/discovery/client": pkg("./marketplace/discovery/client/src/index.ts"),
      "@roster-lock/discovery/server": pkg("./marketplace/discovery/server/src/index.ts"),
      "@roster-lock/discovery": pkg("./marketplace/discovery/server/src/index.ts"),
      "@roster-lock/smart-contract-sdk/rjsf": pkg("./shared/sdk/src/rjsf.ts"),
      "@roster-lock/smart-contract-sdk/react": pkg("./shared/sdk/src/react/index.ts"),
      "@roster-lock/smart-contract-sdk": pkg("./shared/sdk/src/index.ts"),
      "@roster-lock/reviewed-versions": pkg("./shared/review/src/index.ts"),
      "@roster-lock/living-roster-client/model": pkg("./living-roster/client/src/model.ts"),
      "@roster-lock/living-roster-client": pkg("./living-roster/client/src/index.ts"),
      "@roster-lock/smart-contract-client-builder/validator": pkg("./shared/client-builder/src/validator.ts"),
      "@roster-lock/smart-contract-client-builder": pkg("./shared/client-builder/src/index.ts"),
      "@roster-lock/smart-contract-client-host/runtime-entry": pkg("./shared/client-host/src/runtime-entry.ts"),
      "@roster-lock/smart-contract-client-host/fake": pkg("./shared/client-host/src/fake.ts"),
      "@roster-lock/smart-contract-client-host": pkg("./shared/client-host/src/index.ts"),
      "@roster-lock/share-approved/app": pkg("./marketplace/share-approved/src/app.ts"),
      "@roster-lock/share-approved/workflow": pkg("./marketplace/share-approved/src/workflow.ts"),
      "@roster-lock/share-approved": pkg("./marketplace/share-approved/src/index.ts"),
      "@roster-lock/deployed-types": pkg("./shared/deployed-types/src/index.ts"),
    },
  },
  test: {
    // PGlite boots a Postgres WASM instance and QuickJS boots another; running
    // one of each per test file on every core exhausts memory and produced
    // intermittent failures. Four workers keeps the suite deterministic.
    maxWorkers: 4,
    // The same startup cost is slower than the default 5s budget, and the
    // schema-client test pulls React/RJSF into its worker.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
