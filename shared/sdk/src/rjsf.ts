import { Validator as CfSchemaValidator } from "@cfworker/json-schema";
import {
  createErrorHandler,
  toErrorList,
  toErrorSchema,
  validationDataMerge,
} from "@rjsf/utils";
import type {
  CustomValidator,
  ErrorSchema,
  ErrorTransformer,
  FormContextType,
  RJSFSchema,
  RJSFValidationError,
  StrictRJSFSchema,
  UiSchema,
  ValidationData,
  ValidatorType,
} from "@rjsf/utils";

/**
 * A CSP-safe RJSF validator.
 *
 * The stock `@rjsf/validator-ajv8` uses AJV's runtime code generation, which
 * calls `new Function`. Custom clients run in a sandbox with
 * `script-src 'self'` and no `'unsafe-eval'`, and the build rejects `Function`
 * in the final bundle. `@cfworker/json-schema` validates the same JSON Schema
 * in plain JavaScript, so RJSF works without an eval escape hatch.
 */
export function createCspSafeValidator<
  T = any,
  S extends StrictRJSFSchema = RJSFSchema,
  F extends FormContextType = any,
>(): ValidatorType<T, S, F> {
  function rawValidation<R = unknown>(
    schema: S,
    formData?: T,
  ): { errors?: R[]; validationError?: Error } {
    try {
      const validator = new CfSchemaValidator(schema as never, "2020-12", false);
      const result = validator.validate(formData);
      return { errors: mapErrors(result.errors) as unknown as R[] };
    } catch (error) {
      return {
        errors: [],
        validationError: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  return {
    validateFormData(
      formData: T | undefined,
      schema: S,
      customValidate?: CustomValidator<T, S, F>,
      transformErrors?: ErrorTransformer<T, S, F>,
      uiSchema?: UiSchema<T, S, F>,
    ): ValidationData<T> {
      const raw = rawValidation<RJSFValidationError>(schema, formData);
      let errors = raw.errors ?? [];
      if (raw.validationError) {
        const message = raw.validationError.message;
        errors = [
          {
            name: "schema",
            message,
            property: "",
            schemaPath: "",
            stack: `(root) ${message}`,
          },
        ];
      }
      if (transformErrors) errors = transformErrors(errors, uiSchema);
      let data: ValidationData<T> = {
        errors,
        errorSchema: toErrorSchema<T>(errors),
      };
      if (customValidate) {
        const custom = customValidate(
          formData,
          createErrorHandler(formData) as never,
          uiSchema,
        ) as unknown as ErrorSchema<T>;
        data = validationDataMerge(data, custom);
      }
      return data;
    },
    toErrorList(errorSchema?: ErrorSchema<T>, fieldPath?: string[]): RJSFValidationError[] {
      return toErrorList(errorSchema, fieldPath);
    },
    isValid(schema: S, formData: T | undefined): boolean {
      return (rawValidation<RJSFValidationError>(schema, formData).errors ?? []).length === 0;
    },
    rawValidation,
    reset() {
      // No compiled schema cache to reset.
    },
  };
}

function mapErrors(errors: ReadonlyArray<{ instanceLocation: string; keywordLocation: string; keyword: string; error: string }>): RJSFValidationError[] {
  return errors.map((item) => {
    let property = propertyFromLocation(item.instanceLocation);
    if (item.keyword === "required") {
      const missing = /required property "([^"]+)"/.exec(item.error)?.[1];
      if (missing) property = `${property}${propertyForSegment(missing)}`;
    }
    const message = item.error;
    return {
      name: item.keyword,
      message,
      property,
      schemaPath: item.keywordLocation,
      params: { keyword: item.keyword },
      stack: `${property || "(root)"} ${message}`,
    };
  });
}

function propertyFromLocation(location: string): string {
  if (!location || location === "#") return "";
  return location
    .replace(/^#/, "")
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => propertyForSegment(decodePointer(segment)))
    .join("");
}

function propertyForSegment(segment: string): string {
  if (/^\d+$/.test(segment)) return `[${segment}]`;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) return `.${segment}`;
  return `['${segment.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`;
}

function decodePointer(segment: string): string {
  return decodeURIComponent(segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export type { ValidatorType };
