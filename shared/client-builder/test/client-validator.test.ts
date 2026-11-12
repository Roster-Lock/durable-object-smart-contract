import { describe, expect, it } from "vitest";
import { validateClientJavaScript } from "@roster-lock/smart-contract-client-builder/validator";

const codes = (source: string, mode: "source" | "bundle" = "bundle") =>
  validateClientJavaScript(source, { mode }).issues.map((issue) => issue.code);

describe("client static validator", () => {
  it("accepts normal DOM construction", () => {
    const result = validateClientJavaScript(`
      export default function createClient(api) {
        const root = document.createElement("div");
        const button = document.createElement("button");
        button.textContent = "Call";
        button.addEventListener("click", () => api.confirm({ title: "x", message: "y" }));
        root.append(button);
        return root;
      }
    `, { mode: "source" });
    expect(result.ok).toBe(true);
    expect(result.nodes).toBeGreaterThan(0);
  });

  it("rejects network APIs", () => {
    for (const source of [
      `fetch("/x")`,
      `new XMLHttpRequest()`,
      `new WebSocket("wss://x")`,
      `new WebSocketStream("wss://x")`,
      `new EventSource("/x")`,
      `navigator.sendBeacon("/x", "y")`,
      `navigator.serviceWorker.register("/sw.js")`,
    ]) {
      expect(codes(source), source).not.toEqual([]);
    }
  });

  it("rejects eval, Function, workers and dynamic imports", () => {
    expect(codes(`eval("1")`)).toContain("client.eval");
    expect(codes(`new Function("return 1")`)).toContain("client.function_constructor");
    expect(codes(`new Worker("/w.js")`)).toContain("client.worker");
    expect(codes(`new SharedWorker("/w.js")`)).toContain("client.worker");
    expect(codes(`importScripts("/x.js")`)).toContain("client.import_scripts");
    expect(codes(`import("/x.js")`)).toContain("client.dynamic_import");
    expect(codes(`require("x")`)).toContain("client.require");
  });

  it("rejects dynamic scripts, document.write, javascript: and srcdoc", () => {
    expect(codes(`document.createElement("script")`)).toContain("client.dynamic_script");
    expect(codes(`document.createElementNS("http://www.w3.org/1999/xhtml", "script")`)).toContain(
      "client.dynamic_script",
    );
    expect(codes(`const script = document.createElement("div"); script.src = "/x.js"`)).toContain(
      "client.dynamic_script",
    );
    expect(codes(`document.write("<script></script>")`)).toContain("client.forbidden_api");
    expect(codes(`const href = "javascript:alert(1)"`)).toContain("client.javascript_url");
    expect(codes(`iframe.srcdoc = "<script></script>"`)).toContain("client.srcdoc");
  });

  it("rejects innerHTML and parent-page access", () => {
    expect(codes(`element.innerHTML = "<b>x</b>"`)).toContain("client.inner_html");
    expect(codes(`element.insertAdjacentHTML("beforeend", "<b>x</b>")`)).toContain(
      "client.inner_html",
    );
    expect(codes(`const x = parent.document.body`)).toContain("client.parent_dom");
    expect(codes(`const x = window.parent.document`)).toContain("client.parent_dom");
    expect(codes(`const x = document.cookie`)).toContain("client.cookie");
    expect(codes(`const x = localStorage.getItem("x")`)).toContain("client.forbidden_api");
  });

  it("rejects imports and exports after bundling but allows source-mode modules", () => {
    expect(codes(`import x from "x"; export default x`, "bundle")).toEqual(
      expect.arrayContaining(["client.import_after_bundle"]),
    );
    expect(codes(`import x from "x"; export default x`, "source")).toEqual([]);
    expect(codes(`export default 1`, "source")).toEqual([]);
  });

  it("reports a parse error with a location", () => {
    const result = validateClientJavaScript(`const = ;`, { file: "bundle.js" });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("client.parse_error");
    expect(result.issues[0]?.file).toBe("bundle.js");
  });
});
