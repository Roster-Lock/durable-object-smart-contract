import type { AnalysisIssue } from "./types.js";

export type ContractErrorCode =
  | "invalid_request"
  | "analysis_failed"
  | "contract_not_deployed"
  | "unknown_endpoint"
  | "forbidden"
  | "invalid_input"
  | "insufficient_funds"
  | "out_of_gas"
  | "execution_failed"
  | "contract_changed"
  | "schema_changed"
  | "handle_taken"
  | "too_large";

/** Every error the service raises on purpose carries a machine-readable code. */
export class ContractError extends Error {
  readonly code: ContractErrorCode;
  readonly issues: AnalysisIssue[] | undefined;

  constructor(code: ContractErrorCode, message: string, issues?: AnalysisIssue[]) {
    super(message);
    this.name = "ContractError";
    this.code = code;
    this.issues = issues;
  }
}

/** The guest ran past its gas limit (or the wall-clock backstop). */
export class OutOfGasError extends Error {
  constructor(message = "out of gas") {
    super(message);
    this.name = "OutOfGasError";
  }
}

/** A QuickJS handle could not be converted or an eval failed. */
export class QuickJSError extends Error {
  constructor(message: string, readonly stack?: string) {
    super(message);
    this.name = "QuickJSError";
  }
}
