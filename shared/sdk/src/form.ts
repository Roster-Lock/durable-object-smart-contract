import type { UiSchema } from "@rjsf/utils";

const WIDGETS = new Set([
  "text",
  "textarea",
  "select",
  "radio",
  "checkbox",
  "checkboxes",
  "range",
  "password",
  "email",
  "uri",
  "date",
  "datetime",
  "time",
  "color",
]);

/**
 * Turn safe, declarative schema annotations into an RJSF UI schema.
 *
 * Contracts can annotate JSON Schema properties with `title`, `description`,
 * `format`, `"x-roster-input": "piece" | "user"`, `"x-roster-list"` (a fetchable
 * piece/user or labeled-value source list), and a small allowlist of `"x-roster-ui"`
 * hints. Raw RJSF uiSchema is never accepted from a contract: the host maps
 * only known hints, so a schema cannot select an arbitrary component.
 */
export function buildFormUiSchema(schema: unknown): UiSchema {
  const record = isRecord(schema) ? schema : undefined;
  const properties = record && isRecord(record.properties) ? record.properties : undefined;
  const ui: Record<string, unknown> = {};
  if (properties) {
    for (const [name, raw] of Object.entries(properties)) {
      if (!isRecord(raw)) continue;
      const property: Record<string, unknown> = {};
      const marker = raw["x-roster-input"] ?? raw.format;
      if (raw["x-roster-list"] !== undefined || raw["x-roster-source"] !== undefined) {
        property["ui:field"] = "listSource";
      } else if (marker === "piece" || marker === "piece-id") {
        property["ui:field"] = "pieceId";
      } else if (marker === "user" || marker === "user-id") {
        property["ui:field"] = "userId";
      }

      const hints = raw["x-roster-ui"];
      const hintRecord = isRecord(hints) ? hints : undefined;
      const widget = hintRecord ? hintRecord.widget : hints;
      if (typeof widget === "string" && WIDGETS.has(widget)) {
        property["ui:widget"] = widget;
      }
      const placeholder = raw["x-roster-placeholder"] ?? hintRecord?.placeholder;
      if (typeof placeholder === "string" && placeholder.length <= 200) {
        property["ui:placeholder"] = placeholder;
      }
      const help = raw["x-roster-help"] ?? hintRecord?.help;
      if (typeof help === "string" && help.length <= 2_000) {
        property["ui:help"] = help;
      }
      if (Object.keys(property).length > 0) ui[name] = property;
    }
  }

  const order = record?.["x-roster-order"];
  if (Array.isArray(order)) {
    const names = order.filter((item): item is string => typeof item === "string").slice(0, 100);
    if (names.length > 0) ui["ui:order"] = names;
  }
  return ui as UiSchema;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
