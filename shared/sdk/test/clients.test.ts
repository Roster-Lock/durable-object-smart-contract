import { describe, expect, it } from "vitest";
import { buildFormUiSchema } from "@roster-lock/smart-contract-sdk/react";
import { createCspSafeValidator } from "@roster-lock/smart-contract-sdk/rjsf";

describe("custom client form hints", () => {
  it("maps piece and user input hints to custom fields", () => {
    const ui = buildFormUiSchema({
      type: "object",
      properties: {
        piece: { type: "string", "x-roster-input": "piece" },
        opponent: { type: "string", "x-roster-input": "user" },
        note: { type: "string" },
      },
    });
    expect(ui).toEqual({
      piece: { "ui:field": "pieceId" },
      opponent: { "ui:field": "userId" },
    });
  });

  it("supports format hints and ignores non-objects", () => {
    expect(
      buildFormUiSchema({
        properties: {
          piece: { type: "string", format: "piece-id" },
          user: { type: "string", format: "user-id" },
        },
      }),
    ).toEqual({
      piece: { "ui:field": "pieceId" },
      user: { "ui:field": "userId" },
    });
    expect(buildFormUiSchema(undefined)).toEqual({});
  });
});

describe("CSP-safe RJSF validator", () => {
  it("validates JSON Schema without AJV code generation", () => {
    const validator = createCspSafeValidator();
    const schema = {
      type: "object" as const,
      required: ["name"],
      properties: { name: { type: "string" as const, minLength: 2 } },
    };
    const invalid = validator.validateFormData({ name: "a" }, schema);
    expect(invalid.errors.length).toBeGreaterThan(0);
    expect(invalid.errorSchema).toHaveProperty("name");
    expect(validator.isValid(schema, { name: "ab" }, schema)).toBe(true);
    expect(validator.isValid(schema, {}, schema)).toBe(false);
  });
});
