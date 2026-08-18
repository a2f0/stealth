export function normalizeFilename(filename: string, fallback = "upload") {
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
    .trim()
    .slice(0, 255);
  return normalized || fallback;
}
