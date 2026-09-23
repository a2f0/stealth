import {
  degrees,
  PDFDocument,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  rgb,
  StandardFonts,
} from "pdf-lib";

/** A field's box as fractions of its page as displayed (after /Rotate). */
export interface FieldRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

/** A page's crop box in PDF units and its /Rotate, as stored in the file. */
interface PageGeometry {
  cropX: number;
  cropY: number;
  height: number;
  rotation: number;
  width: number;
}

/**
 * Where to draw an upright box that fills a field: its bottom-left origin in
 * PDF user space, the rotation that keeps it upright once the viewer applies
 * /Rotate, and its size along the displayed axes.
 */
interface FieldPlacement {
  boxHeight: number;
  boxWidth: number;
  originX: number;
  originY: number;
  rotate: number;
}

export interface StampedField {
  image?: Uint8Array | undefined;
  page: number;
  rect: FieldRect;
  text?: string | undefined;
}

export interface CertificateSigner {
  email: string;
  ip: string | null;
  name: string;
  signedAt: string;
  userAgent: string | null;
}

export interface Certificate {
  completedAt: string;
  contractId: string;
  documentFilename: string;
  documentPageCount: number;
  documentSha256: string;
  events: Array<{ at: string; description: string }>;
  organizationName: string;
  sentAt: string;
  signers: CertificateSigner[];
  title: string;
}

export class InvalidPdfError extends Error {}

/** Confirms an upload is an unencrypted PDF and counts its pages. */
export async function inspectPdf(bytes: Uint8Array) {
  const header = new TextDecoder().decode(bytes.subarray(0, 1024));
  if (!header.includes("%PDF-")) {
    throw new InvalidPdfError("Upload a PDF document.");
  }
  let pageCount: number;
  try {
    // A damaged file can load and fail only once its page tree is read.
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    pageCount = document.getPageCount();
  } catch (cause) {
    throw new InvalidPdfError(
      cause instanceof Error && cause.name === "EncryptedPDFError"
        ? "Password-protected PDFs can't be sent for signature."
        : "This PDF could not be read.",
    );
  }
  if (pageCount < 1) throw new InvalidPdfError("This PDF has no pages.");
  return { pageCount };
}

/** Maps a displayed-page field box onto PDF user space for any /Rotate. */
export function placeField(
  rect: FieldRect,
  page: PageGeometry,
): FieldPlacement {
  const { cropX, cropY, height: H, width: W } = page;
  const rotation = (((Math.round(page.rotation / 90) * 90) % 360) + 360) % 360;
  if (rotation === 90) {
    // Displayed x runs up the PDF's y axis; displayed y runs along its x.
    return {
      boxHeight: rect.height * W,
      boxWidth: rect.width * H,
      originX: cropX + (rect.y + rect.height) * W,
      originY: cropY + rect.x * H,
      rotate: 90,
    };
  }
  if (rotation === 180) {
    return {
      boxHeight: rect.height * H,
      boxWidth: rect.width * W,
      originX: cropX + (1 - rect.x) * W,
      originY: cropY + (rect.y + rect.height) * H,
      rotate: 180,
    };
  }
  if (rotation === 270) {
    return {
      boxHeight: rect.height * W,
      boxWidth: rect.width * H,
      originX: cropX + (1 - rect.y - rect.height) * W,
      originY: cropY + (1 - rect.x) * H,
      rotate: 270,
    };
  }
  return {
    boxHeight: rect.height * H,
    boxWidth: rect.width * W,
    originX: cropX + rect.x * W,
    originY: cropY + (1 - rect.y - rect.height) * H,
    rotate: 0,
  };
}

/**
 * Draws the signers' values into the original document and appends the
 * certificate of completion.
 */
export async function stampContract(
  original: Uint8Array,
  fields: StampedField[],
  certificate: Certificate,
) {
  const document = await PDFDocument.load(original, { updateMetadata: false });
  const font = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const images = new Map<Uint8Array, PDFImage>();
  for (const field of fields) {
    const page = document.getPage(field.page - 1);
    const placement = placeField(field.rect, geometryOf(page));
    if (field.image) {
      const image =
        images.get(field.image) ?? (await document.embedPng(field.image));
      images.set(field.image, image);
      drawImageInBox(page, placement, image);
    } else if (field.text) {
      drawTextInBox(page, placement, field.text, font);
    }
  }
  appendCertificate(document, certificate, font, bold);
  document.setModificationDate(new Date(certificate.completedAt));
  return document.save();
}

/** Adopted signatures are drawn at 640×160; this bounds what may be decoded. */
const maxSignaturePixels = { height: 800, width: 1600 };

/**
 * Whether a signer's PNG is small enough and decodes, checked when it is
 * submitted so a bad image cannot stall completion later.
 */
export async function isEmbeddablePng(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 33) return false;
  const header = String.fromCharCode(...bytes.subarray(12, 16));
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (
    header !== "IHDR" ||
    width < 1 ||
    height < 1 ||
    width > maxSignaturePixels.width ||
    height > maxSignaturePixels.height
  ) {
    return false;
  }
  try {
    await (await PDFDocument.create()).embedPng(bytes);
    return true;
  } catch {
    return false;
  }
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function geometryOf(page: PDFPage): PageGeometry {
  const crop = page.getCropBox();
  return {
    cropX: crop.x,
    cropY: crop.y,
    height: crop.height,
    rotation: page.getRotation().angle,
    width: crop.width,
  };
}

/** A point in the box's upright frame, in PDF user space. */
function toPage(placement: FieldPlacement, localX: number, localY: number) {
  const radians = (placement.rotate * Math.PI) / 180;
  const cos = Math.round(Math.cos(radians));
  const sin = Math.round(Math.sin(radians));
  return {
    x: placement.originX + localX * cos - localY * sin,
    y: placement.originY + localX * sin + localY * cos,
  };
}

function drawImageInBox(
  page: PDFPage,
  placement: FieldPlacement,
  image: PDFImage,
) {
  const scale = Math.min(
    placement.boxWidth / image.width,
    placement.boxHeight / image.height,
  );
  const width = image.width * scale;
  const height = image.height * scale;
  const origin = toPage(placement, 0, (placement.boxHeight - height) / 2);
  page.drawImage(image, {
    height,
    rotate: degrees(placement.rotate),
    width,
    x: origin.x,
    y: origin.y,
  });
}

function drawTextInBox(
  page: PDFPage,
  placement: FieldPlacement,
  value: string,
  font: PDFFont,
) {
  const padding = Math.min(2, placement.boxWidth / 20);
  const room = placement.boxWidth - padding * 2;
  let text = encodable(value, font);
  let size = Math.min(placement.boxHeight * 0.7, 14);
  while (size > 5 && font.widthOfTextAtSize(text, size) > room) {
    size -= 0.5;
  }
  // Past the smallest legible size, cut the text so it stays in its box.
  if (font.widthOfTextAtSize(text, size) > room) {
    while (text && font.widthOfTextAtSize(`${text}…`, size) > room) {
      text = text.slice(0, -1);
    }
    text = `${text}…`;
  }
  const baseline = (placement.boxHeight - size * 0.72) / 2;
  const origin = toPage(placement, padding, baseline);
  page.drawText(text, {
    color: rgb(0.08, 0.09, 0.1),
    font,
    rotate: degrees(placement.rotate),
    size,
    x: origin.x,
    y: origin.y,
  });
}

/** Replaces characters the standard font cannot encode, such as CJK. */
function encodable(value: string, font: PDFFont) {
  const supported = new Set(font.getCharacterSet());
  return [...value.replace(/[\r\n\t]+/g, " ")]
    .map((character) =>
      supported.has(character.codePointAt(0) ?? 0) ? character : "?",
    )
    .join("");
}

const certificatePage = { height: 792, margin: 54, width: 612 };

function appendCertificate(
  document: PDFDocument,
  certificate: Certificate,
  font: PDFFont,
  bold: PDFFont,
) {
  const lines: Array<{
    bold?: boolean;
    gap?: number;
    size: number;
    text: string;
  }> = [
    { bold: true, size: 18, text: "Certificate of completion" },
    { gap: 6, size: 10, text: `${certificate.organizationName} · Tearleads` },
    { bold: true, gap: 18, size: 12, text: certificate.title },
    { size: 9, text: `Contract ID: ${certificate.contractId}` },
    {
      size: 9,
      text: `Document: ${certificate.documentFilename} (${certificate.documentPageCount} pages before this certificate)`,
    },
    {
      size: 9,
      text: `Document SHA-256 before signing: ${certificate.documentSha256}`,
    },
    { size: 9, text: `Sent: ${formatTimestamp(certificate.sentAt)}` },
    {
      size: 9,
      text: `Completed: ${formatTimestamp(certificate.completedAt)}`,
    },
    { bold: true, gap: 18, size: 12, text: "Signers" },
  ];
  for (const signer of certificate.signers) {
    lines.push(
      {
        bold: true,
        gap: 8,
        size: 10,
        text: `${signer.name} <${signer.email}>`,
      },
      { size: 9, text: `Signed: ${formatTimestamp(signer.signedAt)}` },
      { size: 9, text: `IP address: ${signer.ip ?? "Unknown"}` },
      { size: 9, text: `Device: ${signer.userAgent ?? "Unknown"}` },
    );
  }
  lines.push({ bold: true, gap: 18, size: 12, text: "Activity" });
  for (const event of certificate.events) {
    lines.push({
      size: 9,
      text: `${formatTimestamp(event.at)}  ${event.description}`,
    });
  }
  lines.push({
    gap: 18,
    size: 8,
    text: "Each signer agreed to use electronic records and signatures before signing. Signing links were delivered by email and are unique to each signer.",
  });

  const width = certificatePage.width - certificatePage.margin * 2;
  let page = document.addPage([certificatePage.width, certificatePage.height]);
  let y = certificatePage.height - certificatePage.margin;
  for (const line of lines) {
    const face = line.bold ? bold : font;
    y -= line.gap ?? 0;
    for (const wrapped of wrap(
      encodable(line.text, face),
      face,
      line.size,
      width,
    )) {
      if (y - line.size < certificatePage.margin) {
        page = document.addPage([
          certificatePage.width,
          certificatePage.height,
        ]);
        y = certificatePage.height - certificatePage.margin;
      }
      y -= line.size * 1.35;
      page.drawText(wrapped, {
        color: rgb(0.08, 0.09, 0.1),
        font: face,
        size: line.size,
        x: certificatePage.margin,
        y,
      });
    }
  }
}

/** Breaks text into lines that fit, splitting long unbroken runs too. */
function wrap(text: string, font: PDFFont, size: number, width: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > width) {
      let cut = rest.length - 1;
      while (
        cut > 1 &&
        font.widthOfTextAtSize(rest.slice(0, cut), size) > width
      ) {
        cut -= 1;
      }
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines;
}

function formatTimestamp(value: string) {
  return `${value
    .replace("T", " ")
    .replace(/\.\d+Z$/, "")
    .replace(/Z$/, "")} UTC`;
}
