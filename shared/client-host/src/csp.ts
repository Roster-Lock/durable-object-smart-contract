import { CLIENT_IFRAME_SANDBOX } from "./protocol.js";

export interface ClientCspOptions {
  /** Additional script origins; the bundle is normally same-origin as this document. */
  scriptOrigins?: readonly string[];
  styleOrigins?: readonly string[];
  /** Image origins are off by default; catalog images should be same-origin/data URLs. */
  imageOrigins?: readonly string[];
  /** Allows inline style attributes (React `style={{...}}`) but not inline <style>. */
  allowInlineStyleAttributes?: boolean;
}

/**
 * CSP for the client document. The iframe is sandboxed without
 * `allow-same-origin`, so the document has an opaque origin; `'self'` still
 * refers to the artifact origin for subresources.
 */
export function createClientCsp(options: ClientCspOptions = {}): string {
  const script = ["'self'", ...(options.scriptOrigins ?? [])].join(" ");
  const style = ["'self'", ...(options.styleOrigins ?? [])].join(" ");
  const image = ["'self'", "data:", "blob:", ...(options.imageOrigins ?? [])].join(" ");
  const directives = [
    "default-src 'none'",
    `script-src ${script}`,
    `style-src ${style}`,
    `style-src-attr ${options.allowInlineStyleAttributes === true ? "'unsafe-inline'" : "'none'"}`,
    `img-src ${image}`,
    "font-src 'self'",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "child-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "manifest-src 'none'",
    "navigate-to 'none'",
  ];
  return directives.join("; ");
}

export interface ClientDocumentInput {
  bundleUrl: string;
  runtimeScriptUrl: string;
  styles?: readonly string[];
  title?: string;
  csp?: string;
  rootId?: string;
}

/**
 * The artifact document is static: the bundle and runtime are plain script
 * tags, so there is no runtime module loader and no dynamic script injection.
 * The host sets the fragment token on the iframe URL.
 */
export function createClientDocument(input: ClientDocumentInput): string {
  const csp = input.csp ?? createClientCsp();
  assertHttpUrl(input.bundleUrl, "bundleUrl");
  assertHttpUrl(input.runtimeScriptUrl, "runtimeScriptUrl");
  for (const style of input.styles ?? []) assertHttpUrl(style, "style URL");
  const title = escapeHtml(input.title ?? "Roster Lock client");
  const rootId = input.rootId ?? "roster-client-root";
  const styles = (input.styles ?? [])
    .map((url) => `<link rel="stylesheet" href="${escapeAttribute(url)}">`)
    .join("\n    ");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>${title}</title>
    ${styles}
  </head>
  <body>
    <div id="${escapeAttribute(rootId)}"></div>
    <script src="${escapeAttribute(input.bundleUrl)}"></script>
    <script src="${escapeAttribute(input.runtimeScriptUrl)}" data-root="${escapeAttribute(rootId)}"></script>
  </body>
</html>
`;
}

export interface ClientFrameHeaderInput {
  csp: string;
  /** Host page origin allowed to frame the client document. */
  hostOrigin: string;
  cacheControl?: string;
}

/** Headers the artifact/document Worker must send alongside the HTML. */
export function createClientFrameHeaders(
  input: ClientFrameHeaderInput,
): Record<string, string> {
  const csp = `${input.csp}; frame-ancestors ${input.hostOrigin}`;
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": csp,
    "Cache-Control": input.cacheControl ?? "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  };
}

export function assertSeparateOrigin(
  documentUrl: string,
  hostOrigin: string,
  allowSameOrigin = false,
): URL {
  let url: URL;
  try {
    url = new URL(documentUrl, hostOrigin);
  } catch {
    throw new Error(`invalid client document URL ${JSON.stringify(documentUrl)}`);
  }
  if (allowSameOrigin) return url;
  if (url.origin === hostOrigin) {
    throw new Error(
      "the client document must be served from a separate origin; set allowSameOrigin only for local tests",
    );
  }
  return url;
}

/** Pin checks for stale builds: an explicit build ID must appear in the URL path. */
export function assertPinnedBuild(
  documentUrl: string,
  pin: { buildId: string; sourceHash?: string; bundleHash?: string },
): void {
  const url = new URL(documentUrl, "https://client.invalid");
  if (!url.pathname.includes(pin.buildId) && !url.searchParams.has("build")) {
    throw new Error(
      `client document URL is not pinned to build ${pin.buildId}; stale builds must be pinned explicitly`,
    );
  }
}

export { CLIENT_IFRAME_SANDBOX };

function assertHttpUrl(value: string, name: string): void {
  const url = new URL(value, "https://client.invalid");
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} must be an http(s) URL`);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
