import { installClientRuntime } from "./child.js";

/**
 * Static runtime script for the artifact document. Bundle this entry once and
 * serve the resulting file as `runtimeScriptUrl`; the client bundle itself is
 * a separate import-free script that defines the factory global.
 */
void installClientRuntime();
