import type { ClientApi } from "@roster-lock/smart-contract-sdk";
import { ClientHostProvider } from "@roster-lock/smart-contract-sdk/react";
import { SchemaRosterClient } from "@roster-lock/living-roster-client";

/**
 * Host-side example: render the living-roster UI from the contract's endpoint
 * JSON Schemas. The `inspectPiece` endpoint demonstrates `x-roster-list` with
 * the contract's read-only `roster` source. This is not a custom-client
 * entrypoint; it is a normal React component the website can mount.
 */
export function LivingRosterSchemaClient(props: { api: ClientApi }) {
  return (
    <ClientHostProvider host={props.api}>
      <SchemaRosterClient contractHandle="living-roster" title="Living roster" />
    </ClientHostProvider>
  );
}
