import { deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipLimits {
  maxArchiveBytes: number;
  maxUnpackedBytes: number;
  maxFiles: number;
  maxFileBytes: number;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  compression: 0 | 8;
  mode?: number;
  isDirectory: boolean;
  isSymlink: boolean;
}

export interface ZipReadResult {
  entries: ZipEntry[];
  archiveBytes: number;
  unpackedBytes: number;
}

export class ZipError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** Read a ZIP archive without writing to disk. Supports stored and deflate entries. */
export function readZip(bytes: Uint8Array, limits: ZipLimits): ZipReadResult {
  if (bytes.byteLength > limits.maxArchiveBytes) {
    throw new ZipError(
      "archive.too_large",
      `archive is ${bytes.byteLength} bytes; limit is ${limits.maxArchiveBytes}`,
    );
  }
  if (bytes.byteLength < 22) {
    throw new ZipError("archive.invalid", "archive is not a ZIP file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  if (eocd < 0) throw new ZipError("archive.invalid", "ZIP end-of-central-directory not found");

  const diskNumber = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new ZipError("archive.multi_disk", "multi-disk ZIP archives are not supported");
  }
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ZipError("archive.zip64", "ZIP64 archives are not supported");
  }
  if (totalEntries > limits.maxFiles) {
    throw new ZipError(
      "archive.too_many_files",
      `archive has ${totalEntries} files; limit is ${limits.maxFiles}`,
    );
  }
  if (centralOffset + centralSize > bytes.byteLength) {
    throw new ZipError("archive.invalid", "ZIP central directory is out of bounds");
  }

  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  let unpackedBytes = 0;
  const seen = new Set<string>();
  for (let index = 0; index < totalEntries; index++) {
    if (offset + 46 > bytes.byteLength) {
      throw new ZipError("archive.invalid", "truncated ZIP central directory");
    }
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new ZipError("archive.invalid", "invalid ZIP central directory entry");
    }
    const versionMadeBy = view.getUint16(offset + 4, true);
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const crc32 = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > bytes.byteLength) {
      throw new ZipError("archive.invalid", "truncated ZIP entry name");
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError("archive.zip64", "ZIP64 entries are not supported");
    }
    if (flags & 0x1) throw new ZipError("archive.encrypted", "encrypted ZIP entries are not supported");
    if (flags & 0x40) throw new ZipError("archive.encrypted", "ZIP strong encryption is not supported");
    if (compression !== 0 && compression !== 8) {
      throw new ZipError(
        "archive.compression",
        `unsupported ZIP compression method ${compression}; use store or deflate`,
      );
    }
    const rawName = new TextDecoder(flags & 0x800 ? "utf-8" : "utf-8").decode(
      bytes.subarray(nameStart, nameEnd),
    );
    if (uncompressedSize > limits.maxFileBytes) {
      throw new ZipError(
        "archive.file_too_large",
        `entry ${rawName} is ${uncompressedSize} bytes; limit is ${limits.maxFileBytes}`,
      );
    }
    const name = normalizeZipName(rawName);
    if (seen.has(name)) {
      throw new ZipError("archive.duplicate", `duplicate archive entry ${JSON.stringify(name)}`);
    }
    seen.add(name);

    const unixMode = (versionMadeBy >>> 8) === 3 ? externalAttributes >>> 16 : undefined;
    const fileType = unixMode === undefined ? undefined : unixMode & 0o170000;
    const isSymlink = fileType === 0o120000;
    const isDirectory = rawName.endsWith("/") || fileType === 0o040000;
    if (isSymlink) {
      throw new ZipError("archive.symlink", `archive entry ${JSON.stringify(name)} is a symlink`);
    }
    if (isDirectory) {
      const entry: ZipEntry = {
        name,
        data: new Uint8Array(0),
        compressedSize,
        uncompressedSize: 0,
        crc32,
        compression,
        mode: unixMode,
        isDirectory: true,
        isSymlink: false,
      };
      entries.push(entry);
      offset = nameEnd + extraLength + commentLength;
      continue;
    }

    if (unpackedBytes + uncompressedSize > limits.maxUnpackedBytes) {
      throw new ZipError(
        "archive.unpacked_too_large",
        `archive unpacks to more than ${limits.maxUnpackedBytes} bytes`,
      );
    }
    unpackedBytes += uncompressedSize;

    if (localOffset + 30 > bytes.byteLength) {
      throw new ZipError("archive.invalid", `local header for ${JSON.stringify(name)} is out of bounds`);
    }
    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      throw new ZipError("archive.invalid", `invalid local header for ${JSON.stringify(name)}`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.byteLength) {
      throw new ZipError("archive.invalid", `data for ${JSON.stringify(name)} is out of bounds`);
    }
    const compressed = bytes.subarray(dataStart, dataEnd);
    let data: Uint8Array;
    if (compression === 0) {
      data = compressed.slice();
    } else {
      try {
        data = inflateRawSync(compressed, { maxOutputLength: limits.maxFileBytes });
      } catch (error) {
        throw new ZipError(
          "archive.inflate_failed",
          `could not inflate ${JSON.stringify(name)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (data.byteLength !== uncompressedSize) {
      throw new ZipError(
        "archive.invalid",
        `entry ${JSON.stringify(name)} decompressed to ${data.byteLength} bytes, expected ${uncompressedSize}`,
      );
    }
    if (crc32 !== 0 && crc32 !== crc32Of(data)) {
      throw new ZipError("archive.crc", `CRC mismatch for ${JSON.stringify(name)}`);
    }
    entries.push({
      name,
      data,
      compressedSize,
      uncompressedSize,
      crc32,
      compression: compression as 0 | 8,
      mode: unixMode,
      isDirectory: false,
      isSymlink: false,
    });
    offset = nameEnd + extraLength + commentLength;
  }
  return { entries, archiveBytes: bytes.byteLength, unpackedBytes };
}

function findEocd(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength <= view.byteLength) return offset;
    }
  }
  return -1;
}

export function normalizeZipName(name: string): string {
  if (name.includes("\\")) {
    throw new ZipError("archive.path_traversal", `archive entry ${JSON.stringify(name)} contains a backslash`);
  }
  if (name.includes("\0")) {
    throw new ZipError("archive.path_traversal", "archive entry contains a NUL byte");
  }
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new ZipError("archive.path_traversal", `archive entry ${JSON.stringify(name)} is absolute`);
  }
  const segments = name.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new ZipError("archive.path_traversal", "archive entry has an empty path");
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new ZipError(
      "archive.path_traversal",
      `archive entry ${JSON.stringify(name)} contains a traversal segment`,
    );
  }
  return segments.join("/");
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32Of(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipInputEntry {
  name: string;
  data: Uint8Array | string;
  /** Unix mode; pass 0o120777 for a symlink in tests. */
  mode?: number;
  compress?: boolean;
}

/** Minimal deterministic ZIP writer used by tests and fixtures. */
export function createZip(
  entries: readonly ZipInputEntry[],
  options: { unsafeNames?: boolean } = {},
): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = options.unsafeNames ? entry.name : normalizeZipName(entry.name);
    const nameBytes = encoder.encode(name);
    const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const crc = crc32Of(data);
    const method = entry.compress ? 8 : 0;
    const compressed = entry.compress ? deflateRaw(data) : data;
    const flags = 0x800;
    const local = new Uint8Array(30 + nameBytes.length + compressed.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_SIGNATURE, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, flags, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, compressed.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(compressed, 30 + nameBytes.length);
    localParts.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, CENTRAL_SIGNATURE, true);
    centralView.setUint16(4, entry.mode !== undefined ? (3 << 8) | 20 : 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, flags, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, compressed.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(38, entry.mode !== undefined ? (entry.mode << 16) >>> 0 : 0, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, EOCD_SIGNATURE, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);
  const total = offset + centralSize + eocd.length;
  const result = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, eocd]) {
    result.set(part, cursor);
    cursor += part.length;
  }
  return result;
}

function deflateRaw(data: Uint8Array): Uint8Array {
  return deflateRawSync(data);
}
