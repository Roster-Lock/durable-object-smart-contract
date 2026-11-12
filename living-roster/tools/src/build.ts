import {
  buildJavaScript,
  type BuildOptions,
  type BuildResult,
} from "@roster-lock/smart-contract/builder";

/** Compile a living-roster contract source to one QuickJS script. */
export function buildLivingRoster(
  options: Omit<BuildOptions, "sourcefile"> & { sourcefile?: string },
): Promise<BuildResult> {
  return buildJavaScript({
    ...options,
    sourcefile: options.sourcefile ?? "contract.ts",
  });
}
