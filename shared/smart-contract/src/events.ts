import { Validator } from "@cfworker/json-schema";
import { ContractError } from "./errors.js";
import {
  isPlainObject,
  rejectRefs,
  type SchemaBudget,
} from "./storage/declaration.js";
import type {
  ContractConfig,
  EventManifest,
  JsonSchema,
} from "./types.js";

const EVENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export interface CompiledEvent {
  name: string;
  manifest: EventManifest;
  validator: Validator;
}

export type CompiledEvents = Map<string, CompiledEvent>;

export interface ParsedEvents {
  declarations: Record<string, EventManifest>;
  compiled: CompiledEvents;
}

/**
 * Normalize and compile an `events` block. Like storage, an event is declared
 * with a JSON Schema, so a contract cannot emit a payload the host has not
 * agreed to. The same schema is published in the manifest for consumers.
 */
export function parseEvents(
  raw: unknown,
  config: ContractConfig,
  budget: SchemaBudget = { schemaBytes: 0 },
): ParsedEvents {
  if (raw === undefined) {
    return { declarations: {}, compiled: new Map() };
  }
  if (!isPlainObject(raw)) {
    throw new ContractError("analysis_failed", "events must be an object");
  }
  const entries = Object.entries(raw);
  if (entries.length > config.maxEvents) {
    throw new ContractError(
      "analysis_failed",
      `a contract may declare at most ${config.maxEvents} events`,
    );
  }

  const declarations: Record<string, EventManifest> = {};
  const compiled: CompiledEvents = new Map();

  for (const [name, value] of entries) {
    if (!EVENT_NAME.test(name)) {
      throw new ContractError("analysis_failed", `invalid event name: ${name}`);
    }
    if (!isPlainObject(value)) {
      throw new ContractError(
        "analysis_failed",
        `events.${name} must be an object with a schema`,
      );
    }
    const schema = value.schema;
    if (!isPlainObject(schema)) {
      throw new ContractError(
        "analysis_failed",
        `events.${name}.schema must be a JSON Schema object`,
      );
    }
    if (
      value.description !== undefined &&
      (typeof value.description !== "string" || value.description.length > 256)
    ) {
      throw new ContractError(
        "analysis_failed",
        `events.${name}.description must be a string of at most 256 chars`,
      );
    }
    rejectRefs(schema, `events.${name}.schema`, 0, "event schema");
    budget.schemaBytes += JSON.stringify(schema).length;
    if (budget.schemaBytes > config.maxSchemaBytes) {
      throw new ContractError(
        "analysis_failed",
        `storage and event schemas exceed ${config.maxSchemaBytes} bytes`,
      );
    }

    let validator: Validator;
    try {
      validator = new Validator(schema, "2020-12");
    } catch (error) {
      throw new ContractError(
        "analysis_failed",
        `events.${name}.schema is not a valid JSON Schema: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const manifest: EventManifest = {
      schema: schema as JsonSchema,
      ...(value.description === undefined
        ? {}
        : { description: value.description as string }),
    };
    declarations[name] = manifest;
    compiled.set(name, { name, manifest, validator });
  }

  return { declarations, compiled };
}
