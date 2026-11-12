import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RosterContract } from "@roster-lock/smart-contract-sdk";
import { ClientHostProvider } from "@roster-lock/smart-contract-sdk/react";
import { createFakeClientHost } from "@roster-lock/smart-contract-client-host/fake";
import { SchemaContractClient } from "@roster-lock/living-roster-client";
import { buildFormUiSchema } from "@roster-lock/smart-contract-sdk/react";
import {
  buildEndpointFormModels,
  filterListOptions,
  humanize,
  parseListSource,
  visibleEndpointModels,
} from "@roster-lock/living-roster-client/model";
import { resolveSourceValues } from "@roster-lock/living-roster-client";

const contract: RosterContract = {
  handle: "living-roster",
  name: "Living roster",
  endpoints: {
    propose: {
      access: "human",
      mutates: true,
      gasLimit: 400_000,
      input: {
        type: "object",
        title: "Propose a change",
        description: "Add or remove a piece through a vote.",
        required: ["pieceId"],
        properties: {
          pieceId: {
            type: "string",
            title: "Piece",
            "x-roster-input": "piece",
          },
          note: {
            type: "string",
            "x-roster-ui": { widget: "textarea", placeholder: "Why?", help: "Keep it short" },
          },
        },
        "x-roster-order": ["pieceId", "note"],
      },
    },
    status: {
      access: "public",
      mutates: false,
      input: { type: "object", properties: {} },
    },
    platformOnly: {
      access: "roster-lock",
      mutates: true,
    },
  },
};

describe("schema-driven client model", () => {
  it("derives titles, descriptions and safe RJSF UI hints from endpoint schemas", () => {
    const models = buildEndpointFormModels(contract);
    const propose = models.find((model) => model.name === "propose")!;
    expect(propose.title).toBe("Propose a change");
    expect(propose.description).toContain("vote");
    expect(propose.mutates).toBe(true);
    expect(propose.gasLimit).toBe(400_000);
    expect(propose.confirmMessage).toContain("gas-metered");
    expect(propose.uiSchema).toMatchObject({
      pieceId: { "ui:field": "pieceId" },
      note: {
        "ui:widget": "textarea",
        "ui:placeholder": "Why?",
        "ui:help": "Keep it short",
      },
      "ui:order": ["pieceId", "note"],
    });

    const status = models.find((model) => model.name === "status")!;
    expect(status.hasInput).toBe(false);
    expect(status.access).toBe("public");
    expect(status.mutates).toBe(false);
    expect(status.confirmMessage).toContain("gas-metered");
  });

  it("filters endpoints a browser client cannot call", () => {
    const visible = visibleEndpointModels(contract);
    expect(visible.map((model) => model.name)).toEqual(["propose", "status"]);
  });

  it("ignores unknown UI hints and unsafe field selectors", () => {
    const ui = buildFormUiSchema({
      type: "object",
      properties: {
        danger: {
          type: "string",
          "x-roster-ui": { widget: "remote-code" },
          "ui:field": "evil",
        },
      },
    });
    expect(ui).toEqual({});
  });

  it("humanizes endpoint names", () => {
    expect(humanize("set-limit")).toBe("Set limit");
    expect(humanize("reportMatch")).toBe("Report Match");
  });
});

describe("schema-driven client rendering", () => {
  it("renders endpoint forms from the manifest without contract code", () => {
    const fake = createFakeClientHost();
    // RJSF's TextareaWidget still uses React defaultProps in this major; the
    // warning is library noise, not a client error.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const html = renderToStaticMarkup(
      createElement(ClientHostProvider, {
        host: fake.host,
        children: createElement(SchemaContractClient, { contract }),
      }),
    );
    errorSpy.mockRestore();
    expect(html).toContain("Propose a change");
    expect(html).toContain("Add or remove a piece through a vote.");
    expect(html).toContain("Search pieces");
    expect(html).toContain("Call transaction");
  });
});

describe("list sources", () => {
  it("parses piece/user fetchable sources and labeled-value sources", () => {
    expect(parseListSource("catalog:pieces")).toEqual({ kind: "piece" });
    const piece = parseListSource({
      type: "piece",
      include: [{ handle: "living-roster", endpoint: "listPieces" }],
      exclude: [{ handle: "moderation", endpoint: "blockedPieces" }],
    });
    expect(piece).toEqual({
      kind: "piece",
      include: [{ handle: "living-roster", endpoint: "listPieces" }],
      exclude: [{ handle: "moderation", endpoint: "blockedPieces" }],
    });
    const labeled = parseListSource({
      type: "labeled-value",
      include: [
        { handle: "modes", endpoint: "listModes" },
        { handle: "themes", endpoint: "listThemes" },
      ],
      exclude: [{ handle: "modes", endpoint: "retiredModes" }],
    });
    expect(labeled).toMatchObject({ kind: "labeled-value" });
    expect(labeled && "include" in labeled ? labeled.include : []).toHaveLength(2);
    expect(parseListSource({ type: "labeled-value" })).toBeUndefined();
    expect(
      parseListSource({ type: "piece", include: [{ handle: "", endpoint: "x" }] }),
    ).toBeUndefined();
    expect(parseListSource({ type: "unknown" })).toBeUndefined();
  });

  it("applies include then exclude, with exclude winning", () => {
    const options = [
      { value: "p1", label: "One" },
      { value: "p2", label: "Two" },
      { value: "p3", label: "Three" },
      { value: "p1", label: "One again" },
    ];
    expect(
      filterListOptions(options, {
        include: new Set(["p1", "p2"]),
        exclude: new Set(["p2"]),
      }),
    ).toEqual([{ value: "p1", label: "One" }]);
    expect(filterListOptions(options, { exclude: new Set(["p3"]) })).toEqual([
      { value: "p1", label: "One" },
      { value: "p2", label: "Two" },
    ]);
  });

  it("maps x-roster-list to the listSource field", () => {
    expect(
      buildFormUiSchema({
        type: "object",
        properties: {
          pieceId: {
            type: "string",
            "x-roster-list": {
              type: "piece",
              include: [{ handle: "living-roster", endpoint: "listPieces" }],
            },
          },
          mode: {
            type: "string",
            "x-roster-source": {
              type: "labeled-value",
              include: [{ handle: "modes", endpoint: "listModes" }],
            },
          },
        },
      }),
    ).toMatchObject({
      pieceId: { "ui:field": "listSource" },
      mode: { "ui:field": "listSource" },
    });
  });
});

describe("fetchable list sources", () => {
  function sourceHost() {
    const contracts: RosterContract[] = [
      {
        handle: "living-roster",
        name: "Living roster",
        endpoints: {
          listPieces: { access: "public", mutates: false },
          blockedPieces: { access: "public", mutates: false },
          listModes: { access: "public", mutates: false },
          mutating: { access: "public", mutates: true },
          platformOnly: { access: "roster-lock", mutates: false },
        },
      },
    ];
    const fake = createFakeClientHost({
      contracts,
      callResult: async (_handle, endpoint) => {
        switch (endpoint) {
          case "listPieces":
            return { items: [{ id: "p1", title: "One" }, { id: "p2", title: "Two" }] };
          case "blockedPieces":
            return ["p2"];
          case "listModes":
            return [{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }];
          default:
            return [];
        }
      },
    });
    return fake;
  }

  it("unions include sources and subtracts exclude sources", async () => {
    const fake = sourceHost();
    const included = await resolveSourceValues(
      fake.host,
      [{ handle: "living-roster", endpoint: "listPieces" }],
      "options",
      false,
    );
    expect(included.options).toEqual([
      { value: "p1", label: "One" },
      { value: "p2", label: "Two" },
    ]);
    const excluded = await resolveSourceValues(
      fake.host,
      [{ handle: "living-roster", endpoint: "blockedPieces" }],
      "values",
      false,
    );
    expect([...excluded.values]).toEqual(["p2"]);
    expect(
      filterListOptions(included.options, {
        include: included.values,
        exclude: excluded.values,
      }),
    ).toEqual([{ value: "p1", label: "One" }]);
  });

  it("caches source reads and enforces read-only/public sources", async () => {
    const fake = sourceHost();
    const source = { handle: "living-roster", endpoint: "listPieces" } as const;
    await resolveSourceValues(fake.host, [source], "options", false);
    await resolveSourceValues(fake.host, [source], "options", false);
    expect(fake.calls.filter((call) => call.endpoint === "listPieces")).toHaveLength(1);

    await expect(
      resolveSourceValues(
        fake.host,
        [{ handle: "living-roster", endpoint: "mutating" }],
        "options",
        false,
      ),
    ).rejects.toThrow(/mutates:false/);
    await expect(
      resolveSourceValues(
        fake.host,
        [{ handle: "living-roster", endpoint: "platformOnly" }],
        "options",
        false,
      ),
    ).rejects.toThrow(/not callable/);
    await expect(
      resolveSourceValues(fake.host, [{ handle: "missing", endpoint: "x" }], "options", false),
    ).rejects.toThrow(/was not found/);
  });

  it("requires labeled-value items to be {value,label}", async () => {
    const fake = sourceHost();
    const labeled = await resolveSourceValues(
      fake.host,
      [{ handle: "living-roster", endpoint: "listModes" }],
      "options",
      true,
    );
    expect(labeled.options).toEqual([
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ]);

    const invalid = sourceHost();
    invalid.host.roster.call = async () => ["not-labeled"];
    await expect(
      resolveSourceValues(
        invalid.host,
        [{ handle: "living-roster", endpoint: "listModes" }],
        "options",
        true,
      ),
    ).rejects.toThrow(/\{ value, label \}/);
  });
});
