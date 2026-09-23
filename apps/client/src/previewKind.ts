type PreviewKind = "image" | "pdf";

/**
 * Raster formats every supported browser decodes. SVG is left out on
 * purpose: an inbound attachment is untrusted, and SVG is a document format.
 */
const imageTypes = new Map([
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
]);

/** Senders often label attachments generically; fall back to the name. */
const genericTypes = new Set([
  "",
  "application/binary",
  "application/octet-stream",
  "binary/octet-stream",
]);

/** How an attachment can be previewed in the browser, if at all. */
export function previewKindFor(attachment: {
  contentType: string;
  filename: string;
}): PreviewKind | null {
  const type = (attachment.contentType.split(";")[0] ?? "")
    .trim()
    .toLowerCase();
  const extension = extensionOf(attachment.filename);
  if (type === "application/pdf" || type === "application/x-pdf") {
    return "pdf";
  }
  if ([...imageTypes.values()].includes(type)) return "image";
  if (!genericTypes.has(type)) return null;
  if (extension === "pdf") return "pdf";
  return imageTypes.has(extension) ? "image" : null;
}

function extensionOf(filename: string) {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
}
