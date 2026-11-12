export type ClientBuildPhase =
  | "archive"
  | "manifest"
  | "packages"
  | "transform"
  | "bundle"
  | "validate"
  | "publish"
  | "internal";

export interface ClientBuildDiagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  hint?: string;
}

export interface ClientBuildIssueContext {
  phase: ClientBuildPhase;
  file?: string;
}

export class ClientBuildError extends Error {
  readonly diagnostics: ClientBuildDiagnostic[];
  readonly phase: ClientBuildPhase;
  readonly file?: string;

  constructor(
    message: string,
    diagnostics: ClientBuildDiagnostic[] = [],
    phase: ClientBuildPhase = "internal",
    file?: string,
  ) {
    super(message);
    this.name = "ClientBuildError";
    this.diagnostics = diagnostics.length
      ? diagnostics
      : [{ severity: "error", code: "build.failed", message }];
    this.phase = phase;
    this.file = file;
  }
}

export function diagnostic(
  code: string,
  message: string,
  options: {
    severity?: "error" | "warning";
    file?: string;
    line?: number;
    column?: number;
    hint?: string;
  } = {},
): ClientBuildDiagnostic {
  return {
    severity: options.severity ?? "error",
    code,
    message,
    ...(options.file ? { file: options.file } : {}),
    ...(options.line !== undefined ? { line: options.line } : {}),
    ...(options.column !== undefined ? { column: options.column } : {}),
    ...(options.hint ? { hint: options.hint } : {}),
  };
}

export function fail(
  code: string,
  message: string,
  options: {
    phase?: ClientBuildPhase;
    file?: string;
    line?: number;
    column?: number;
    hint?: string;
    diagnostics?: ClientBuildDiagnostic[];
  } = {},
): never {
  const diagnostics = options.diagnostics ?? [
    diagnostic(code, message, {
      file: options.file,
      line: options.line,
      column: options.column,
      hint: options.hint,
    }),
  ];
  throw new ClientBuildError(message, diagnostics, options.phase ?? "internal", options.file);
}

export function isClientBuildError(error: unknown): error is ClientBuildError {
  return error instanceof ClientBuildError;
}
