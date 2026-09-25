export const maxFilenameBytes = 255;

export function normalizeFilename(
  filename: string,
  fallback = "upload",
  maxBytes = maxFilenameBytes,
) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Filename byte limit must be a positive integer.");
  }
  const normalized = [...filename]
    .map((character) => {
      const code = character.charCodeAt(0);
      return character === "/" ||
        character === "\\" ||
        character === '"' ||
        code <= 31 ||
        code === 127
        ? "-"
        : character;
    })
    .join("")
    .trim();
  return (
    truncateUtf8(normalized, maxBytes) ||
    truncateUtf8(fallback, maxBytes) ||
    truncateUtf8("upload", maxBytes)
  );
}

function truncateUtf8(value: string, maxBytes: number) {
  const encoder = new TextEncoder();
  let byteLength = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (byteLength + characterBytes > maxBytes) break;
    byteLength += characterBytes;
    result += character;
  }
  return result;
}
