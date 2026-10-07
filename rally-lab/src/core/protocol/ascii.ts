// Commands and replies are plain ASCII, so the core encodes them itself and
// stays free of TextEncoder/TextDecoder (not present on every JS runtime).

export function encodeAscii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[i] = c < 128 ? c : 63; // '?'
  }
  return out;
}

export function decodeAscii(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
