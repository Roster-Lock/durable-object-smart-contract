import { useEffect, useState, type ComponentType } from "react";
import FormImport from "@rjsf/core";
import type { FormProps, IChangeEvent } from "@rjsf/core";
import type { FieldProps } from "@rjsf/utils";
import type { Piece, RosterContract, UserSummary } from "@roster-lock/smart-contract-sdk";
import { createCspSafeValidator } from "@roster-lock/smart-contract-sdk/rjsf";
import { useAsync, useClientHost } from "@roster-lock/smart-contract-sdk/react";
import {
  buildEndpointFormModels,
  visibleEndpointModels,
  type EndpointFormModel,
} from "./model.js";
import { ListSourceField } from "./list-source-field.js";
import { clearSourceCache } from "./source.js";

const Form = FormImport as unknown as ComponentType<FormProps>;
const validator = createCspSafeValidator();

function PieceField(props: FieldProps) {
  const host = useClientHost();
  const value = typeof props.value === "string" ? props.value : "";
  const [query, setQuery] = useState("");
  const [piece, setPiece] = useState<Piece | undefined>();
  const [results, setResults] = useState<Piece[]>([]);

  useEffect(() => {
    if (!value) {
      setPiece(undefined);
      return;
    }
    let live = true;
    host.catalog.getPiece(value).then((item) => live && setPiece(item));
    return () => {
      live = false;
    };
  }, [host, value]);

  useEffect(() => {
    let live = true;
    host.catalog.searchPieces(query, 8).then((items) => live && setResults(items));
    return () => {
      live = false;
    };
  }, [host, query]);

  return (
    <div id={props.id} className="rl-schema-piece">
      {value ? (
        <p>
          Selected: {piece?.title ?? value}{" "}
          <button type="button" onClick={() => props.onChange("")}>
            Clear
          </button>
        </p>
      ) : null}
      <input
        aria-label={props.label ?? "Piece"}
        placeholder="Search pieces"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {results.length > 0 ? (
        <ul>
          {results.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => {
                  props.onChange(item.id);
                  setResults([]);
                }}
              >
                {item.title}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {props.rawErrors?.map((error) => (
        <p key={error} role="alert">
          {error}
        </p>
      ))}
    </div>
  );
}

function UserField(props: FieldProps) {
  const host = useClientHost();
  const value = typeof props.value === "string" ? props.value : "";
  const [query, setQuery] = useState("");
  const [user, setUser] = useState<UserSummary | undefined>();
  const [results, setResults] = useState<UserSummary[]>([]);

  useEffect(() => {
    if (!value) {
      setUser(undefined);
      return;
    }
    let live = true;
    host.catalog.getUser(value).then((item) => live && setUser(item));
    return () => {
      live = false;
    };
  }, [host, value]);

  useEffect(() => {
    let live = true;
    host.catalog.searchUsers(query, 8).then((items) => live && setResults(items));
    return () => {
      live = false;
    };
  }, [host, query]);

  return (
    <div id={props.id} className="rl-schema-user">
      {value ? (
        <p>
          Selected: {user?.displayName ?? value}{" "}
          <button type="button" onClick={() => props.onChange("")}>
            Clear
          </button>
        </p>
      ) : null}
      <input
        aria-label={props.label ?? "User"}
        placeholder="Search users"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {results.length > 0 ? (
        <ul>
          {results.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => {
                  props.onChange(item.id);
                  setResults([]);
                }}
              >
                {item.displayName}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {props.rawErrors?.map((error) => (
        <p key={error} role="alert">
          {error}
        </p>
      ))}
    </div>
  );
}

const FIELDS = {
  pieceId: PieceField,
  userId: UserField,
  listSource: ListSourceField,
} as unknown as FormProps["fields"];

function EndpointPanel(props: {
  contract: RosterContract;
  model: EndpointFormModel;
  onResult?: (endpoint: string, result: unknown) => void;
}) {
  const host = useClientHost();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<unknown>();

  async function call(input: unknown): Promise<void> {
    if (!props.model.callable) return;
    // Every endpoint call is gas-metered in the contract runtime, including
    // read-only views; the host owns the confirmation UI.
    const confirmed = await host.confirm({
      title: props.model.confirmTitle,
      message: props.model.confirmMessage,
      details: {
        handle: props.contract.handle,
        endpoint: props.model.name,
        mutates: props.model.mutates,
        gasLimit: props.model.gasLimit ?? null,
      },
    });
    if (!confirmed) return;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const value = await host.roster.call(
        props.contract.handle,
        props.model.name,
        input as never,
      );
      setResult(value);
      clearSourceCache(host);
      props.onResult?.(props.model.name, value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`endpoint-${props.model.name}`}>
      <h3 id={`endpoint-${props.model.name}`}>{props.model.title}</h3>
      {props.model.description ? <p>{props.model.description}</p> : null}
      <p className="rl-schema-badges">
        <span>{props.model.access}</span>
        <span>{props.model.mutates ? "paid/gas-metered" : "read-only"}</span>
        {props.model.gasLimit ? <span>gas {props.model.gasLimit}</span> : null}
      </p>

      {props.model.hasInput ? (
        <Form
          schema={props.model.schema as never}
          uiSchema={props.model.uiSchema}
          validator={validator}
          fields={FIELDS}
          formContext={{ contractHandle: props.contract.handle }}
          disabled={busy}
          onSubmit={(event: IChangeEvent) => {
            void call(event.formData ?? null);
          }}
        >
          <button type="submit" disabled={busy}>
            {busy ? "Calling…" : props.model.mutates ? "Call transaction" : "Run"}
          </button>
        </Form>
      ) : (
        <button type="button" disabled={busy} onClick={() => void call(null)}>
          {busy ? "Calling…" : props.model.mutates ? "Call transaction" : "Run"}
        </button>
      )}

      {error ? <p role="alert">{error}</p> : null}
      {result !== undefined ? (
        <section>
          <h4>Result</h4>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </section>
      ) : null}
    </section>
  );
}

export interface SchemaContractClientProps {
  contract: RosterContract;
  title?: string;
  initialEndpoint?: string;
  onResult?: (endpoint: string, result: unknown) => void;
}

/**
 * A client generated entirely from the contract manifest's endpoint input JSON
 * Schemas. It renders forms with RJSF and calls the host API; no contract code
 * runs in the page.
 */
export function SchemaContractClient(props: SchemaContractClientProps) {
  const models = visibleEndpointModels(props.contract);
  const [selected, setSelected] = useState(
    props.initialEndpoint ?? models[0]?.name ?? "",
  );
  const model = models.find((item) => item.name === selected) ?? models[0];

  return (
    <section className="rl-schema-client">
      <h2>{props.title ?? props.contract.name}</h2>
      {models.length === 0 ? (
        <p>This contract has no public or human-callable endpoints.</p>
      ) : (
        <>
          <nav aria-label="Endpoints">
            {models.map((item) => (
              <button
                key={item.name}
                type="button"
                aria-pressed={item.name === model?.name}
                onClick={() => setSelected(item.name)}
              >
                {item.title}
              </button>
            ))}
          </nav>
          {model ? (
            <EndpointPanel
              contract={props.contract}
              model={model}
              {...(props.onResult ? { onResult: props.onResult } : {})}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

export interface SchemaRosterClientProps {
  contractHandle?: string;
  title?: string;
  onResult?: (endpoint: string, result: unknown) => void;
}

/** Resolve the roster's contracts and render the schema-driven client for one. */
export function SchemaRosterClient(props: SchemaRosterClientProps) {
  const host = useClientHost();
  const state = useAsync(() => host.roster.listContracts(), [host]);
  const [handle, setHandle] = useState(props.contractHandle ?? "");
  const contracts = state.data ?? [];

  useEffect(() => {
    if (!handle && contracts[0]) setHandle(contracts[0].handle);
  }, [contracts, handle]);

  if (state.loading) return <p>Loading contracts…</p>;
  if (state.error) return <p role="alert">{state.error.message}</p>;
  if (contracts.length === 0) return <p>No contracts found for this roster.</p>;

  const contract = contracts.find((item) => item.handle === handle) ?? contracts[0];
  return (
    <section>
      {contracts.length > 1 ? (
        <label>
          Contract{" "}
          <select value={contract?.handle ?? ""} onChange={(event) => setHandle(event.target.value)}>
            {contracts.map((item) => (
              <option key={item.handle} value={item.handle}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {contract ? (
        <SchemaContractClient
          contract={contract}
          {...(props.title ? { title: props.title } : {})}
          {...(props.onResult ? { onResult: props.onResult } : {})}
        />
      ) : null}
    </section>
  );
}

