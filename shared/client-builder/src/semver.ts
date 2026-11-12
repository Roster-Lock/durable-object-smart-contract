export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
  build: string[];
}

const SEMVER_RE =
  /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function parseSemver(value: string): SemVer | undefined {
  const match = SEMVER_RE.exec(value.trim());
  if (!match) return undefined;
  const [, major, minor, patch, pre, build] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: pre
      ? pre.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : [],
    build: build ? build.split(".") : [],
  };
}

export function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (typeof left === "number" && typeof right === "number") {
      if (left !== right) return left - right;
    } else if (typeof left === "number") {
      return -1;
    } else if (typeof right === "number") {
      return 1;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

export function maxSatisfying(
  versions: readonly string[],
  range: string,
): string | undefined {
  const parsed = versions
    .map((version) => ({ version, parsed: parseSemver(version) }))
    .filter((entry): entry is { version: string; parsed: SemVer } => Boolean(entry.parsed))
    .filter((entry) => satisfies(entry.parsed, range));
  if (parsed.length === 0) return undefined;
  parsed.sort((a, b) => compareSemver(b.parsed, a.parsed));
  return parsed[0]?.version;
}

/**
 * A deliberately small semver range implementation: enough for npm package
 * dependencies (exact, `*`, `^`, `~`, comparators, `||`, hyphen ranges,
 * `x`/`X` wildcards). It rejects malformed ranges instead of guessing.
 */
export function satisfies(version: SemVer | string, range: string): boolean {
  const parsed = typeof version === "string" ? parseSemver(version) : version;
  if (!parsed) return false;
  const trimmed = range.trim();
  if (!trimmed || trimmed === "*" || trimmed.toLowerCase() === "latest") return true;
  return trimmed.split("||").some((alternative) => {
    const part = alternative.trim();
    if (!part) return false;
    const hyphen = /^([^\s]+)\s+-\s+([^\s]+)$/.exec(part);
    if (hyphen) {
      const low = parseSemver(hyphen[1]!);
      const high = parseSemver(hyphen[2]!);
      return Boolean(low && high && compareSemver(parsed, low) >= 0 && compareSemver(parsed, high) <= 0);
    }
    return part.split(/\s+/).every((token) => satisfiesComparator(parsed, token));
  });
}

function satisfiesComparator(version: SemVer, token: string): boolean {
  if (!token || token === "*" || token.toLowerCase() === "x") return true;
  if (token.startsWith("^")) {
    const low = parseLoose(token.slice(1));
    if (!low) return false;
    return compareSemver(version, low) >= 0 && compareSemver(version, upperForCaret(low)) < 0;
  }
  if (token.startsWith("~")) {
    const low = parseLoose(token.slice(1));
    if (!low) return false;
    const upper: SemVer = {
      major: low.major,
      minor: low.minor + 1,
      patch: 0,
      prerelease: [],
      build: [],
    };
    return compareSemver(version, low) >= 0 && compareSemver(version, upper) < 0;
  }
  if (token.startsWith(">=")) {
    const low = parseLoose(token.slice(2));
    return Boolean(low && compareSemver(version, low) >= 0);
  }
  if (token.startsWith("<=")) {
    const high = parseLoose(token.slice(2));
    return Boolean(high && compareSemver(version, high) <= 0);
  }
  if (token.startsWith(">")) {
    const low = parseLoose(token.slice(1));
    return Boolean(low && compareSemver(version, low) > 0);
  }
  if (token.startsWith("<")) {
    const high = parseLoose(token.slice(1));
    return Boolean(high && compareSemver(version, high) < 0);
  }
  if (token.startsWith("=")) {
    const exact = parseLoose(token.slice(1));
    return Boolean(exact && compareSemver(version, exact) === 0);
  }
  const exact = parseLoose(token);
  return Boolean(exact && compareSemver(version, exact) === 0);
}

function parseLoose(value: string): SemVer | undefined {
  const cleaned = value.trim();
  if (!cleaned || cleaned === "*" || cleaned.toLowerCase() === "x") return undefined;
  const exact = parseSemver(cleaned);
  if (exact) return exact;
  const wildcard = /^([0-9]+|[xX*])(?:\.([0-9]+|[xX*]))?(?:\.([0-9]+|[xX*]))?$/.exec(
    cleaned,
  );
  if (!wildcard) return undefined;
  const major = wildcard[1];
  const minor = wildcard[2];
  const patch = wildcard[3];
  if (!major || /^[xX*]$/.test(major)) return { major: 0, minor: 0, patch: 0, prerelease: [], build: [] };
  return {
    major: Number(major),
    minor: minor && !/^[xX*]$/.test(minor) ? Number(minor) : 0,
    patch: patch && !/^[xX*]$/.test(patch) ? Number(patch) : 0,
    prerelease: [],
    build: [],
  };
}

function upperForCaret(low: SemVer): SemVer {
  if (low.major > 0) {
    return { major: low.major + 1, minor: 0, patch: 0, prerelease: [], build: [] };
  }
  if (low.minor > 0) {
    return { major: 0, minor: low.minor + 1, patch: 0, prerelease: [], build: [] };
  }
  return { major: 0, minor: 0, patch: low.patch + 1, prerelease: [], build: [] };
}

export function isExactVersion(value: string): boolean {
  return Boolean(parseSemver(value));
}
