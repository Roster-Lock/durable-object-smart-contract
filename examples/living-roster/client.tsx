import { useEffect, useState, type ComponentType } from "react";
import FormImport from "@rjsf/core";
import type { FormProps, IChangeEvent } from "@rjsf/core";
import type { FieldProps, RJSFSchema } from "@rjsf/utils";
import { createRoot } from "react-dom/client";
import { useClientHost, useAsync, buildFormUiSchema, ClientHostProvider } from "@roster-lock/smart-contract-sdk/react";
import { createCspSafeValidator } from "@roster-lock/smart-contract-sdk/rjsf";
import type { ClientApi, ClientHost, Piece, UserSummary } from "@roster-lock/smart-contract-sdk";

const Form = FormImport as unknown as ComponentType<FormProps>;
const validator = createCspSafeValidator();

interface Proposal {
  id: string;
  action: "add" | "remove";
  pieceId: string;
  proposer: string;
  yes: number;
  no: number;
  resolved: boolean;
  outcome?: string;
}

interface RosterStorage {
  proposals?: Record<string, Proposal>;
  roster?: string[];
  config?: { quorum: number; approval: number; rosterLimit: number };
}

function PieceDisplay(props: { pieceId: string }) {
  const host = useClientHost();
  const [piece, setPiece] = useState<Piece | undefined>();
  useEffect(() => {
    let live = true;
    host.catalog.getPiece(props.pieceId).then((value) => live && setPiece(value));
    return () => {
      live = false;
    };
  }, [host, props.pieceId]);
  return piece ? (
    <span>
      {piece.imageUrl ? <img src={piece.imageUrl} alt="" width={24} height={24} /> : null}{" "}
      {piece.url ? <a href={piece.url}>{piece.title}</a> : piece.title}
    </span>
  ) : (
    <span>{props.pieceId}</span>
  );
}

function UserDisplay(props: { userId: string }) {
  const host = useClientHost();
  const [user, setUser] = useState<UserSummary | undefined>();
  useEffect(() => {
    let live = true;
    host.catalog.getUser(props.userId).then((value) => live && setUser(value));
    return () => {
      live = false;
    };
  }, [host, props.userId]);
  return <span>{user?.displayName ?? props.userId}</span>;
}

function PieceIdField(props: FieldProps) {
  const host = useClientHost();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Piece[]>([]);
  const value = typeof props.value === "string" ? props.value : "";

  useEffect(() => {
    let live = true;
    host.catalog.searchPieces(query, 8).then((items) => live && setResults(items));
    return () => {
      live = false;
    };
  }, [host, query]);

  return (
    <div id={props.id}>
      {value ? (
        <p>
          Selected: <PieceDisplay pieceId={value} />{" "}
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
          {results.map((piece) => (
            <li key={piece.id}>
              <button
                type="button"
                onClick={() => {
                  props.onChange(piece.id);
                  setResults([]);
                }}
              >
                <PieceDisplay pieceId={piece.id} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function UserIdField(props: FieldProps) {
  const host = useClientHost();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserSummary[]>([]);
  const value = typeof props.value === "string" ? props.value : "";

  useEffect(() => {
    let live = true;
    host.catalog.searchUsers(query, 8).then((items) => live && setResults(items));
    return () => {
      live = false;
    };
  }, [host, query]);

  return (
    <div id={props.id}>
      {value ? (
        <p>
          Selected: <UserDisplay userId={value} />{" "}
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
          {results.map((user) => (
            <li key={user.id}>
              <button
                type="button"
                onClick={() => {
                  props.onChange(user.id);
                  setResults([]);
                }}
              >
                <UserDisplay userId={user.id} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const FIELDS = { pieceId: PieceIdField, userId: UserIdField };

async function confirm(host: ClientHost, title: string, message: string): Promise<boolean> {
  return host.confirm({
    title,
    message: `${message}\n\nYou will pay the gas for this call.`,
  });
}

function LivingRosterClient(props: { contractHandle?: string }) {
  const host = useClientHost();
  const [handle, setHandle] = useState(props.contractHandle ?? "living-roster");
  const [contracts, setContracts] = useState<Awaited<ReturnType<ClientHost["roster"]["listContracts"]>>>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const [proposalId, setProposalId] = useState("");

  useEffect(() => {
    host.roster.listContracts().then(setContracts).catch((cause) => setError(String(cause)));
  }, [host]);

  const contract = contracts.find((item) => item.handle === handle);
  const storageState = useAsync<RosterStorage>(
    () => host.roster.getStorage(handle) as Promise<RosterStorage>,
    [host, handle, refreshKey],
  );

  const refresh = () => setRefreshKey((value) => value + 1);
  const propose = contract?.endpoints.propose;
  const vote = contract?.endpoints.vote;

  async function call(endpoint: string, input: unknown) {
    const ok = await confirm(host, "Submit transaction", `Call ${handle}.${endpoint}?`);
    if (!ok) return;
    setError(undefined);
    try {
      await host.roster.call(handle, endpoint, input as never);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const proposals = Object.values(storageState.data?.proposals ?? {});
  const roster = storageState.data?.roster ?? [];

  return (
    <section>
      <h2>Living roster</h2>
      <label>
        Contract{" "}
        <select value={handle} onChange={(event) => setHandle(event.target.value)}>
          {contracts.map((item) => (
            <option key={item.handle} value={item.handle}>
              {item.name}
            </option>
          ))}
        </select>
      </label>

      {propose ? (
        <section>
          <h3>Propose a change</h3>
          <Form
            schema={(propose.input as RJSFSchema | undefined) ?? { type: "object" }}
            uiSchema={buildFormUiSchema(propose.input)}
            validator={validator}
            fields={FIELDS}
            onSubmit={async (event: IChangeEvent) => {
              await call("propose", event.formData);
            }}
          >
            <button type="submit">Propose</button>
          </Form>
        </section>
      ) : null}

      <section>
        <h3>Vote state</h3>
        {proposals.length === 0 ? <p>No proposals.</p> : null}
        {proposals.map((proposal) => (
          <article key={proposal.id}>
            <h4>
              {proposal.action} <PieceDisplay pieceId={proposal.pieceId} />
            </h4>
            <p>
              Proposed by <UserDisplay userId={proposal.proposer} /> · yes {proposal.yes} / no{" "}
              {proposal.no} · {proposal.resolved ? `resolved (${proposal.outcome})` : "open"}
            </p>
            {!proposal.resolved && vote ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void call("vote", { proposalId: proposal.id, support: true });
                }}
              >
                <button type="submit">Vote yes</button>
              </form>
            ) : null}
            {!proposal.resolved && vote ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void call("vote", { proposalId: proposal.id, support: false });
                }}
              >
                <button type="submit">Vote no</button>
              </form>
            ) : null}
            {!proposal.resolved ? (
              <button type="button" onClick={() => void call("resolve", { proposalId: proposal.id })}>
                Resolve
              </button>
            ) : null}
          </article>
        ))}
        <label>
          Proposal id{" "}
          <input value={proposalId} onChange={(event) => setProposalId(event.target.value)} />
        </label>
        <button
          type="button"
          disabled={!proposalId}
          onClick={() => void call("proposal", { proposalId })}
        >
          Load proposal
        </button>
      </section>

      <section>
        <h3>Roster</h3>
        {roster.length === 0 ? <p>The roster is empty.</p> : null}
        <ul>
          {roster.map((pieceId) => (
            <li key={pieceId}>
              <PieceDisplay pieceId={pieceId} />
            </li>
          ))}
        </ul>
      </section>

      {storageState.error ? <p role="alert">{storageState.error.message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

/**
 * The only required export is a function that receives the host API and
 * returns a DOM node. This example chooses React/RJSF internally; another
 * client can use vanilla DOM or any other UI library.
 */
export default function createClient(api: ClientApi): HTMLElement {
  const root = document.createElement("div");
  createRoot(root).render(
    <ClientHostProvider host={api}>
      <LivingRosterClient />
    </ClientHostProvider>,
  );
  return root;
}
