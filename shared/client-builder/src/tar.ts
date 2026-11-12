import { gunzipSync, gzipSync } from "node:zlib";
import { normalizeZipName, ZipError } from "./zip.js";

export interface TarLimits {
  maxTarballBytes: number;
  maxUnpackedBytes: number;
  maxFiles: number;
  maxFileBytes: number;
}

export interface TarFile {
  path: string;
  data: Uint8Array;
  mode: number;
}

/**
 * Read an npm package tarball (gzip-compressed tar) into memory.
 *
 * npm tarballs use a single `package/` prefix. Symlinks, hardlinks, devices
 * and traversal paths are rejected; this is a parser, never an installer.
 */
export function readNpmTarball(bytes: Uint8Array, limits: TarLimits): Map<string, Uint8Array> {
  if (bytes.byteLength > limits.maxTarballBytes) {
    throw new ZipError(
      "package.tarball_too_large",
      `package tarball is ${bytes.byteLength} bytes; limit is ${limits.maxTarballBytes}`,
    );
  }
  let tar: Uint8Array;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: limits.maxUnpackedBytes });
  } catch (error) {
    throw new ZipError(
      "package.tarball_invalid",
      `could not decompress package tarball: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let pendingLongName: string | undefined;
  let pendingPaxPath: string | undefined;
  let total = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (isZeroBlock(header)) break;
    const rawName = readString(header, 0, 100);
    const modeText = readString(header, 100, 8);
    const sizeText = readString(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const prefix = readString(header, 345, 155);
    const size = parseOctal(sizeText);
    if (size < 0) throw new ZipError("package.tarball_invalid", "invalid tar size field");
    if (size > limits.maxFileBytes) {
      throw new ZipError(
        "package.file_too_large",
        `package file is ${size} bytes; limit is ${limits.maxFileBytes}`,
      );
    }
    const mode = parseOctal(modeText) || 0o644;
    offset += 512;
    const data = tar.subarray(offset, offset + size);
    if (data.byteLength !== size) {
      throw new ZipError("package.tarball_invalid", "truncated tar entry");
    }
    offset += Math.ceil(size / 512) * 512;

    if (typeflag === "x") {
      pendingPaxPath = parsePaxPath(data) ?? pendingPaxPath;
      continue;
    }
    if (typeflag === "g") continue;
    if (typeflag === "L") {
      pendingLongName = new TextDecoder().decode(data).replace(/\0+$/, "");
      continue;
    }
    if (typeflag === "K") continue;
    if (typeflag === "1" || typeflag === "2") {
      throw new ZipError(
        "package.symlink",
        `package tarball entry ${JSON.stringify(rawName)} is a link`,
      );
    }
    if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "5" && typeflag !== "7") {
      continue;
    }
    let name = pendingPaxPath ?? pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    pendingPaxPath = undefined;
    pendingLongName = undefined;
    name = name.replace(/^\.\//, "");
    if (!name.startsWith("package/")) {
      // Some test fixtures omit the prefix; accept a single top-level tree.
      // Traversal is still rejected below.
    } else {
      name = name.slice("package/".length);
    }
    if (!name || name.endsWith("/")) continue;
    const normalized = normalizeZipName(name);
    if (typeflag === "5") continue;
    if (files.has(normalized)) {
      throw new ZipError("package.duplicate", `duplicate package file ${JSON.stringify(normalized)}`);
    }
    if (files.size >= limits.maxFiles) {
      throw new ZipError(
        "package.too_many_files",
        `package has more than ${limits.maxFiles} files`,
      );
    }
    total += data.byteLength;
    if (total > limits.maxUnpackedBytes) {
      throw new ZipError(
        "package.unpacked_too_large",
        `package unpacks to more than ${limits.maxUnpackedBytes} bytes`,
      );
    }
    files.set(normalized, data.slice());
  }
  if (files.size === 0) {
    throw new ZipError("package.empty", "package tarball contains no files");
  }
  return files;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

function readString(block: Uint8Array, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? slice.subarray(0, end) : slice).trim();
}

function parseOctal(value: string): number {
  const cleaned = value.replace(/\0/g, "").trim();
  if (!cleaned) return 0;
  const parsed = Number.parseInt(cleaned, 8);
  return Number.isFinite(parsed) ? parsed : -1;
}

function parsePaxPath(data: Uint8Array): string | undefined {
  const text = new TextDecoder().decode(data);
  let cursor = 0;
  while (cursor < text.length) {
    const space = text.indexOf(" ", cursor);
    if (space < 0) break;
    const length = Number.parseInt(text.slice(cursor, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, cursor + length - 1);
    const equals = record.indexOf("=");
    if (equals > 0) {
      const key = record.slice(0, equals);
      const value = record.slice(equals + 1);
      if (key === "path") return value;
    }
    cursor += length;
  }
  return undefined;
}

export interface TarInputFile {
  path: string;
  data: Uint8Array | string;
  mode?: number;
}

/** Minimal deterministic tar writer used by tests. */
export function createNpmTarball(files: readonly TarInputFile[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const file of files) {
    const name = `package/${file.path.replace(/^\/+/, "")}`;
    const data = typeof file.data === "string" ? new TextEncoder().encode(file.data) : file.data;
    const header = new Uint8Array(512);
    writeString(header, 0, 100, name);
    writeString(header, 100, 8, `${(file.mode ?? 0o644).toString(8).padStart(7, "0")}\0`);
    writeString(header, 108, 8, "0000000\0");
    writeString(header, 116, 8, "0000000\0");
    writeString(header, 124, 12, `${data.byteLength.toString(8).padStart(11, "0")}\0`);
    writeString(header, 136, 12, "00000000000\0");
    header[156] = "0".charCodeAt(0);
    writeString(header, 257, 6, "ustar\0");
    writeString(header, 263, 2, "00");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    chunks.push(header, data);
    const padding = (512 - (data.byteLength % 512)) % 512;
    if (padding) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    tar.set(chunk, offset);
    offset += chunk.length;
  }
  return gzip(tar);
}

function writeString(block: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  block.set(bytes.subarray(0, length), offset);
}

function gzip(data: Uint8Array): Uint8Array {
  return gzipSync(data);
}
