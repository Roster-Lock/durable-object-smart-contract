import { describe, expectTypeOf, it } from "vitest";
import type {
  StoredArray,
  StoredMap,
  StoredValue,
  StorageConfig,
  UsableStorage,
} from "@roster-lock/match-making";

const storage = {
  ratings: {
    kind: "map",
    value: { kind: "value", schema: { type: "integer" } },
  },
  history: {
    kind: "array",
    value: { kind: "value", schema: { type: "string" } },
  },
  current: { kind: "value", schema: { type: "boolean" } },
  nested: {
    kind: "map",
    value: {
      kind: "map",
      value: { kind: "value", schema: { type: "integer" } },
    },
  },
} as const satisfies StorageConfig;

type Storage = UsableStorage<typeof storage>;

describe("matchmaker storage types", () => {
  it("maps kind and schema to the runtime handle", () => {
    expectTypeOf<Storage["ratings"]>().toEqualTypeOf<StoredMap<number>>();
    expectTypeOf<Storage["history"]>().toEqualTypeOf<StoredArray<string>>();
    expectTypeOf<Storage["current"]>().toEqualTypeOf<StoredValue<boolean>>();
    expectTypeOf<Storage["nested"]>().toEqualTypeOf<StoredMap<StoredMap<number>>>();
  });
});
