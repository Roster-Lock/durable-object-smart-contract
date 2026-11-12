/**
 * Production entry point: deploy, call and settle living-roster contracts.
 * The runtime lives in @roster-lock/smart-contract; this package is the stable
 * living-roster server surface.
 */
export {
  ContractService,
  ContractError,
  OutOfGasError,
  GasMeter,
  Sandbox,
  SandboxRuntime,
  ContractStorage,
  parseStorage,
  migrate,
  readOnlyTransaction,
  transaction,
  WalletLedger,
  listContracts,
} from "@roster-lock/smart-contract";
export { SmartContractDurableObject } from "@roster-lock/smart-contract/cloudflare";
export { openPostgres } from "@roster-lock/smart-contract/postgres";
export type {
  CallInput,
  CallLogEntry,
  CallResult,
  ContractConfig,
  ContractEvent,
  ContractFilter,
  ContractManifest,
  ContractRecord,
  ContractSummary,
  ContractServiceOptions,
  DeployInput,
  DeployPreview,
  DeployResult,
  EndpointAccess,
  EndpointManifest,
  EventManifest,
  JsonValue,
  StorageCollection,
  StorageDeclarations,
  StorageNode,
} from "@roster-lock/smart-contract";

export * from "./adoption.js";
