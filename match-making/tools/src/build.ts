import {
  buildJavaScript,
  type BuildOptions,
  type BuildResult,
} from "@roster-lock/smart-contract/builder";

/** Compile a matchmaker source to one QuickJS script. */
export function buildMatchmaker(
  options: Omit<BuildOptions, "sourcefile"> & { sourcefile?: string },
): Promise<BuildResult> {
  return buildJavaScript({
    ...options,
    sourcefile: options.sourcefile ?? "matchmaker.ts",
  });
}
