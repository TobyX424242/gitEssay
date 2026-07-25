/**
 * Unicode-safe base64 helpers. `btoa`/`atob` only accept Latin-1 input and
 * throw `InvalidCharacterError` on characters like ∀, ∑, α (common in LaTeX),
 * so route through TextEncoder/TextDecoder (UTF-8) first.
 */

export function b64EncodeUnicode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function b64DecodeUnicode(encoded: string): string {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
