import { createHash } from "node:crypto";
import { ClientBuildError, diagnostic } from "./errors.js";
import type { ClientFramework } from "./types.js";

export interface FrameworkTransformInput {
  path: string;
  source: string;
  framework: ClientFramework;
}

export interface FrameworkStyle {
  path: string;
  content: string;
}

export interface FrameworkTransformResult {
  code: string;
  /** Loader esbuild should use for the transformed output. */
  loader?: "js" | "ts";
  styles?: FrameworkStyle[];
  warnings?: string[];
}

export interface FrameworkAdapter {
  id: string;
  extensions: readonly string[];
  transform(input: FrameworkTransformInput): Promise<FrameworkTransformResult>;
}

export interface FrameworkAdapterOptions {
  /** Loaded lazily so a Svelte build does not require the compiler at import time. */
  loadSvelteCompiler?: () => Promise<SvelteCompilerLike>;
}

interface SvelteCompilerLike {
  compile(
    source: string,
    options: { filename: string; generate: "client"; dev?: boolean },
  ): { js: { code: string }; warnings?: Array<{ message: string }> };
}

/**
 * React/TSX needs no source rewrite; esbuild's `jsx: "automatic"` transform
 * handles it. The adapter exists so framework selection is explicit and so a
 * future React-specific transform has a home.
 */
export const reactAdapter: FrameworkAdapter = {
  id: "react",
  extensions: [".tsx", ".jsx", ".ts", ".js"],
  async transform(input) {
    return { code: input.source, loader: input.path.endsWith(".ts") || input.path.endsWith(".tsx") ? "ts" : "js" };
  },
};

export const vanillaAdapter: FrameworkAdapter = {
  id: "vanilla",
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
  async transform(input) {
    return { code: input.source, loader: input.path.endsWith(".ts") || input.path.endsWith(".tsx") ? "ts" : "js" };
  },
};

/**
 * Vue SFC adapter. It uses the official compiler, so `<script setup>`, normal
 * `<script>`, templates and scoped styles follow Vue's own semantics.
 */
export const vueAdapter: FrameworkAdapter = {
  id: "vue",
  extensions: [".vue"],
  async transform(input) {
    const compiler = await loadVueCompiler();
    const { descriptor, errors } = compiler.parse(input.source, { filename: input.path });
    if (errors.length > 0) {
      throw new ClientBuildError(
        "Vue SFC could not be parsed",
        errors.map((error) =>
          diagnostic("framework.vue_parse", String(error.message ?? error), { file: input.path }),
        ),
        "transform",
        input.path,
      );
    }
    if (descriptor.script?.src || descriptor.scriptSetup?.src) {
      throw new ClientBuildError("external Vue script blocks are not supported", [
        diagnostic(
          "framework.vue_external_script",
          "inline <script> and <script setup> blocks; external src files are not resolved",
          { file: input.path },
        ),
      ], "transform", input.path);
    }
    if (descriptor.template?.src) {
      throw new ClientBuildError("external Vue templates are not supported", [
        diagnostic("framework.vue_external_template", "inline the <template> block", { file: input.path }),
      ], "transform", input.path);
    }
    const id = createHash("sha256").update(`${input.path}\0${input.source}`).digest("hex").slice(0, 8);
    const warnings: string[] = [];
    let code: string;
    if (descriptor.scriptSetup) {
      const compiled = compiler.compileScript(descriptor, {
        id,
        inlineTemplate: Boolean(descriptor.template),
      });
      code = compiled.content;
      // compileScript({ inlineTemplate: true }) already appended the render
      // function and the component default export.
    } else {
      const compiled = compiler.compileScript(descriptor, { id });
      let scriptCode = compiled.content;
      const marker = "export default";
      const index = scriptCode.lastIndexOf(marker);
      if (index >= 0) {
        scriptCode = `${scriptCode.slice(0, index)}const __sfc_main =${scriptCode.slice(
          index + marker.length,
        )}`;
      } else {
        scriptCode += "\nconst __sfc_main = {};";
      }
      if (descriptor.template) {
        const template = compiler.compileTemplate({
          source: descriptor.template.content,
          filename: input.path,
          id,
          compilerOptions: { bindingMetadata: compiled.bindings },
        });
        if (template.errors.length > 0) {
          throw new ClientBuildError(
            "Vue template could not be compiled",
            template.errors.map((error) =>
              diagnostic("framework.vue_template", String(error.message ?? error), {
                file: input.path,
              }),
            ),
            "transform",
            input.path,
          );
        }
        code = `${scriptCode}\n${template.code}\n__sfc_main.render = render;\nexport default __sfc_main;`;
      } else {
        code = `${scriptCode}\nexport default __sfc_main;`;
      }
    }
    const styles: FrameworkStyle[] = [];
    for (const [index, style] of descriptor.styles.entries()) {
      const compiledStyle = compiler.compileStyle({
        source: style.content,
        filename: input.path,
        id: `data-v-${id}`,
        scoped: Boolean(style.scoped),
      });
      if (compiledStyle.errors.length > 0) {
        throw new ClientBuildError(
          "Vue style block could not be compiled",
          compiledStyle.errors.map((error) =>
            diagnostic("framework.vue_style", String(error.message ?? error), { file: input.path }),
          ),
          "transform",
          input.path,
        );
      }
      styles.push({
        path: `${input.path}.${index}.css`,
        content: compiledStyle.code,
      });
    }
    return { code, loader: "ts", styles, warnings };
  },
};

export const svelteAdapter: FrameworkAdapter = {
  id: "svelte",
  extensions: [".svelte"],
  async transform(input) {
    let compiler: SvelteCompilerLike;
    try {
      compiler = await loadSvelteCompiler();
    } catch (error) {
      throw new ClientBuildError("Svelte compiler is not installed", [
        diagnostic(
          "framework.compiler_missing",
          `Svelte SFC support requires the build service to install svelte: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { file: input.path, hint: "install svelte in the build container or ship React/Vue" },
        ),
      ], "transform", input.path);
    }
    const compiled = compiler.compile(input.source, {
      filename: input.path,
      generate: "client",
      dev: false,
    });
    return {
      code: compiled.js.code,
      loader: "js",
      warnings: (compiled.warnings ?? []).map((warning) => warning.message),
    };
  },
};

export const angularAdapter: FrameworkAdapter = {
  id: "angular",
  extensions: [".ts"],
  async transform(input) {
    throw new ClientBuildError("Angular needs a dedicated builder", [
      diagnostic(
        "framework.angular_requires_builder",
        "Angular templates, decorators and its linker need the Angular compiler/CLI; the generic esbuild+Rollup adapter does not compile Angular",
        {
          file: input.path,
          hint: "use a framework=vanilla/React client, or add an Angular builder path that emits an import-free bundle",
        },
      ),
    ], "transform", input.path);
  },
};

export function frameworkAdapters(
  options: FrameworkAdapterOptions = {},
): readonly FrameworkAdapter[] {
  return [reactAdapter, vanillaAdapter, vueAdapter, svelteAdapter, angularAdapter];
}

export function selectFrameworkAdapter(
  path: string,
  framework: ClientFramework,
  options: FrameworkAdapterOptions = {},
): FrameworkAdapter | undefined {
  if (path.endsWith(".vue")) return vueAdapter;
  if (path.endsWith(".svelte")) return svelteAdapter;
  if (framework === "angular") return angularAdapter;
  if (framework === "vue") return vueAdapter;
  if (framework === "svelte") return svelteAdapter;
  if (framework === "react") return reactAdapter;
  return vanillaAdapter;
}

async function loadVueCompiler(): Promise<VueCompilerLike> {
  const module = (await import("@vue/compiler-sfc")) as unknown as VueCompilerLike;
  return module;
}

async function loadSvelteCompiler(): Promise<SvelteCompilerLike> {
  const specifier = "svelte/compiler";
  const module = (await import(specifier)) as { compile?: SvelteCompilerLike["compile"] };
  if (typeof module.compile !== "function") throw new Error("svelte/compiler has no compile export");
  return { compile: module.compile };
}

interface VueCompilerLike {
  parse(source: string, options: { filename: string }): {
    descriptor: VueSfcDescriptor;
    errors: Array<{ message?: string }>;
  };
  compileScript(
    descriptor: VueSfcDescriptor,
    options: { id: string; inlineTemplate?: boolean },
  ): { content: string; bindings?: Record<string, unknown> };
  compileTemplate(options: {
    source: string;
    filename: string;
    id: string;
    compilerOptions?: { bindingMetadata?: Record<string, unknown> };
  }): { code: string; errors: Array<{ message?: string }> };
  compileStyle(options: {
    source: string;
    filename: string;
    id: string;
    scoped: boolean;
  }): { code: string; errors: Array<{ message?: string }> };
}

interface VueSfcDescriptor {
  script?: { content: string; src?: string };
  scriptSetup?: { content: string; src?: string };
  template?: { content: string; src?: string };
  styles: Array<{ content: string; scoped?: boolean }>;
}
