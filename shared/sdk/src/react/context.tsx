import { createContext, useContext, type ReactNode } from "react";
import type { ClientHost } from "../host.js";

const ClientHostContext = createContext<ClientHost | undefined>(undefined);

export function ClientHostProvider(props: {
  host: ClientHost;
  children: ReactNode;
}) {
  return (
    <ClientHostContext.Provider value={props.host}>
      {props.children}
    </ClientHostContext.Provider>
  );
}

export function useClientHost(): ClientHost {
  const host = useContext(ClientHostContext);
  if (!host) throw new Error("ClientHostProvider is missing");
  return host;
}
