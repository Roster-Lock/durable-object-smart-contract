import type {
  ClientHost,
  ConfirmInput,
  LadderEntry,
  PlayerStats,
  RosterContract,
} from "@roster-lock/smart-contract-sdk";

export interface FakeClientHostOptions {
  session?: ClientHost["session"];
  player?: (userId: string) => PlayerStats | undefined;
  ladder?: LadderEntry[];
  contracts?: RosterContract[];
  storage?: Record<string, Record<string, unknown>>;
  confirm?: boolean;
  callResult?: (
    handle: string,
    endpoint: string,
    input: unknown,
  ) => unknown | Promise<unknown>;
}

export interface FakeClientHost {
  host: ClientHost;
  confirmations: ConfirmInput[];
  calls: Array<{ handle: string; endpoint: string; input: unknown }>;
}

/**
 * A host implementation for tests and local harnesses. It is deliberately
 * boring: everything is in memory and every call is recorded.
 */
export function createFakeClientHost(options: FakeClientHostOptions = {}): FakeClientHost {
  const confirmations: ConfirmInput[] = [];
  const calls: FakeClientHost["calls"] = [];
  const contracts = options.contracts ?? [];
  const storage = options.storage ?? {};
  const host: ClientHost = {
    session: options.session ?? { userId: "user-1", displayName: "Test User" },
    matchmaker: {
      async getPlayer(userId) {
        return (
          options.player?.(userId) ?? {
            userId,
            displayName: userId,
            mmr: 1000,
            matchesPlayed: 0,
          }
        );
      },
      async getLadder() {
        return { items: options.ladder ?? [] };
      },
      async getRecentMatches() {
        return [];
      },
    },
    roster: {
      async listContracts() {
        return contracts;
      },
      async getContract(handle) {
        return contracts.find((contract) => contract.handle === handle);
      },
      async getStorage(handle) {
        return storage[handle] ?? {};
      },
      async call(handle, endpoint, input) {
        calls.push({ handle, endpoint, input });
        if (options.callResult) return (await options.callResult(handle, endpoint, input)) as never;
        return null;
      },
    },
    catalog: {
      async getPiece(id) {
        return { id, title: `Piece ${id}` };
      },
      async searchPieces(query) {
        return query ? [{ id: query, title: `Piece ${query}` }] : [];
      },
      async getUser(id) {
        return { id, displayName: id };
      },
      async searchUsers(query) {
        return query ? [{ id: query, displayName: `User ${query}` }] : [];
      },
    },
    async confirm(input) {
      confirmations.push(input);
      return options.confirm ?? true;
    },
  };
  return { host, confirmations, calls };
}
