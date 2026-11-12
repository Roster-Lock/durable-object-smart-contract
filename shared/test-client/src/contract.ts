import { ContractService } from "@roster-lock/smart-contract";
import type { ContractConfig } from "@roster-lock/smart-contract";
import { freshTestDatabase, type TestDatabase } from "./db.js";

export const LIVING_ROSTER = `
defineContract({
  name: "living-roster",
  version: "1.0.0",
  storage: {
    rosters: {
      kind: "map",
      key: { type: "string", minLength: 1 },
      value: {
        kind: "array",
        maxItems: 100,
        item: { type: "string", minLength: 1 },
      },
    },
    meta: {
      kind: "map",
      key: { type: "string" },
      value: { type: "string" },
    },
    flag: { kind: "value", schema: { type: "string" } },
  },
  endpoints: {
    addPiece: {
      gasLimit: 800000,
      run: async (input, ctx) => {
        const roster = await ctx.storage.rosters.get(input.rosterId);
        const size = await roster.length();
        if (size >= input.capacity) throw new Error("roster is full");
        await roster.addToTop([input.pieceId]);
        return { size: await roster.length(), caller: ctx.msgSender.id };
      },
    },
    list: {
      run: async (input, ctx) => {
        const roster = await ctx.storage.rosters.get(input.rosterId);
        return await roster.slice(0, 100);
      },
    },
    removeBottom: {
      run: async (input, ctx) => {
        const roster = await ctx.storage.rosters.get(input.rosterId);
        const length = await roster.length();
        return await roster.removeAt(length - input.count, input.count);
      },
    },
    setMeta: {
      run: async (input, ctx) => {
        await ctx.storage.meta.set("owner", input.owner);
        return await ctx.storage.meta.get("owner");
      },
    },
    flag: {
      run: async (_input, ctx) => (await ctx.storage.flag.get()) ?? null,
    },
  },
});
`;

export interface TestService {
  service: ContractService;
  db: TestDatabase;
}

export async function makeService(
  options: {
    config?: Partial<ContractConfig>;
    now?: () => number;
    contractId?: string;
    rosterId?: string;
  } = {},
): Promise<TestService> {
  const db = await freshTestDatabase();
  const service = new ContractService({
    contractId: options.contractId ?? "test-contract",
    rosterId: options.rosterId,
    openDb: db.open,
    now: options.now,
    config: {
      defaultGasLimit: 1_000_000,
      maxGasPerCall: 2_000_000,
      minGasLimit: 10_000,
      deployGasLimit: 5_000_000,
      hardTimeoutMs: 2_000,
      ...options.config,
    },
  });
  await service.initialize();
  return { service, db };
}
