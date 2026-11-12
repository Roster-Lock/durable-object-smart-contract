const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  // ASCII fast path; contract payloads are overwhelmingly JSON.
  let ascii = true;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) {
      ascii = false;
      break;
    }
  }
  return ascii ? value.length : encoder.encode(value).length;
}

export function clampInt(value: unknown, min: number, max: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : min;
  if (number < min) return min;
  if (number > max) return max;
  return number;
}

export function assertByteLimit(value: string, maxBytes: number, label: string): number {
  const bytes = utf8ByteLength(value);
  if (bytes > maxBytes) {
    throw new RangeError(`${label} is ${bytes} bytes, limit is ${maxBytes}`);
  }
  return bytes;
}
