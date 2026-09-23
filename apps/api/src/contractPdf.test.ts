import { describe, expect, it } from "bun:test";
import {
  decodePDFRawStream,
  degrees,
  PDFArray,
  PDFDocument,
  PDFName,
  type PDFPage,
  PDFRawStream,
} from "pdf-lib";
import {
  type Certificate,
  InvalidPdfError,
  inspectPdf,
  isEmbeddablePng,
  placeField,
  sha256Hex,
  stampContract,
} from "./contractPdf";

// A letter page, 612 × 792 points, with its crop box offset from the origin.
const letter = { cropX: 10, cropY: 20, height: 792, width: 612 };
// A box in the displayed page's top-left quarter.
const rect = { height: 0.1, width: 0.25, x: 0.1, y: 0.2 };

const certificate: Certificate = {
  completedAt: "2026-09-23T15:00:00.000Z",
  contractId: "contract-1",
  documentFilename: "agreement.pdf",
  documentPageCount: 2,
  documentSha256: "ab".repeat(32),
  events: [
    { at: "2026-09-23T14:00:00.000Z", description: "Sent by Olivia Owner" },
    { at: "2026-09-23T15:00:00.000Z", description: "Signed by Sam Signer" },
  ],
  organizationName: "Acme, Inc.",
  sentAt: "2026-09-23T14:00:00.000Z",
  signers: [
    {
      email: "sam@example.com",
      ip: "203.0.113.7",
      name: "Sam Signer",
      signedAt: "2026-09-23T15:00:00.000Z",
      userAgent: "Mozilla/5.0 (Macintosh) Safari/605.1.15",
    },
  ],
  title: "Services agreement",
};

describe("placeField", () => {
  it("maps an upright page from the top-left to PDF's bottom-left origin", () => {
    const upright = placeField(rect, { ...letter, rotation: 0 });
    expect(upright.rotate).toBe(0);
    expect(upright.boxWidth).toBeCloseTo(153);
    expect(upright.boxHeight).toBeCloseTo(79.2);
    expect(upright.originX).toBeCloseTo(10 + 61.2);
    expect(upright.originY).toBeCloseTo(20 + 792 * 0.7);
  });

  it("maps each quarter turn so the box stays upright on screen", () => {
    // Rotated 90°, the page displays 792 wide and 612 tall.
    const quarter = placeField(rect, { ...letter, rotation: 90 });
    expect(quarter.rotate).toBe(90);
    expect(quarter.boxWidth).toBeCloseTo(0.25 * 792);
    expect(quarter.boxHeight).toBeCloseTo(0.1 * 612);
    expect(quarter.originX).toBeCloseTo(10 + 0.3 * 612);
    expect(quarter.originY).toBeCloseTo(20 + 0.1 * 792);

    const half = placeField(rect, { ...letter, rotation: 180 });
    expect(half.rotate).toBe(180);
    expect(half.originX).toBeCloseTo(10 + 0.9 * 612);
    expect(half.originY).toBeCloseTo(20 + 0.3 * 792);

    const threeQuarter = placeField(rect, { ...letter, rotation: -90 });
    expect(threeQuarter.rotate).toBe(270);
    expect(threeQuarter.boxWidth).toBeCloseTo(0.25 * 792);
    expect(threeQuarter.originX).toBeCloseTo(10 + 0.7 * 612);
    expect(threeQuarter.originY).toBeCloseTo(20 + 0.9 * 792);
  });
});

describe("inspectPdf", () => {
  it("counts pages and rejects files that are not readable PDFs", async () => {
    expect(await inspectPdf(await samplePdf())).toEqual({ pageCount: 2 });
    await expect(
      inspectPdf(new TextEncoder().encode("not a pdf")),
    ).rejects.toBeInstanceOf(InvalidPdfError);
    await expect(
      inspectPdf(new TextEncoder().encode("%PDF-1.7\nbroken")),
    ).rejects.toThrow("could not be read");
  });
});

describe("stampContract", () => {
  it("stamps fields on rotated and upright pages and appends the certificate", async () => {
    const original = await samplePdf();
    const signature = await pngBytes();
    const stamped = await stampContract(
      original,
      [
        { image: signature, page: 1, rect },
        { page: 1, rect: { ...rect, y: 0.4 }, text: "2026-09-23" },
        { image: signature, page: 2, rect },
        { page: 2, rect: { ...rect, y: 0.5 }, text: "Sam Signer – 山田" },
      ],
      certificate,
    );
    const reloaded = await PDFDocument.load(stamped);
    expect(reloaded.getPageCount()).toBe(3);
    expect(reloaded.getPage(1).getRotation().angle).toBe(90);
    for (const page of reloaded.getPages().slice(0, 2)) {
      const operators = contentStreams(page).join("\n");
      expect(operators).toContain(" Do");
      expect(operators).toContain(" Tj");
    }
    expect(await sha256Hex(stamped)).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex(stamped)).not.toBe(await sha256Hex(original));
  });

  it("isolates stamps from a page's unbalanced transformation", async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([612, 792]);
    // A producer's flip with no restoring Q would otherwise mirror stamps.
    page.node.set(
      PDFName.of("Contents"),
      source.context.register(
        source.context.flateStream("1 0 0 -1 0 792 cm 0 0 m 10 10 l S"),
      ),
    );
    const stamped = await stampContract(
      await source.save(),
      [{ page: 1, rect, text: "Director" }],
      certificate,
    );
    const streams = contentStreams(
      (await PDFDocument.load(stamped)).getPage(0),
    );
    expect(streams.slice(0, 3).map((stream) => stream.trim())).toEqual([
      "q",
      "1 0 0 -1 0 792 cm 0 0 m 10 10 l S",
      "Q",
    ]);
    expect(streams.at(-1)).toContain(" Tj");
  });

  it("cuts text that cannot fit its box", async () => {
    const stamped = await stampContract(
      await samplePdf(),
      [
        {
          page: 1,
          rect: { height: 0.03, width: 0.1, x: 0.1, y: 0.1 },
          text: "Chief Executive Officer ".repeat(20),
        },
      ],
      certificate,
    );
    const operators = contentStreams(
      (await PDFDocument.load(stamped)).getPage(0),
    ).join("\n");
    const drawn = /<([0-9A-F]+)> Tj/.exec(operators)?.[1] ?? "";
    // Helvetica codes are one byte, so each character is two hex digits.
    expect(drawn.length / 2).toBeLessThan(40);
    expect(drawn.endsWith("85")).toBe(true);
  });

  it("continues a long activity log onto more certificate pages", async () => {
    const events = Array.from({ length: 120 }, (_, index) => ({
      at: "2026-09-23T14:00:00.000Z",
      description: `Reminder ${index + 1} sent to sam@example.com`,
    }));
    const stamped = await stampContract(await samplePdf(), [], {
      ...certificate,
      events,
    });
    expect((await PDFDocument.load(stamped)).getPageCount()).toBeGreaterThan(3);
  });
});

describe("isEmbeddablePng", () => {
  it("accepts small PNGs and rejects oversized or undecodable ones", async () => {
    const valid = await pngBytes();
    expect(await isEmbeddablePng(valid)).toBe(true);
    const huge = valid.slice();
    new DataView(huge.buffer).setUint32(16, 20_000);
    new DataView(huge.buffer).setUint32(20, 20_000);
    expect(await isEmbeddablePng(huge)).toBe(false);
    const garbage = Uint8Array.from([...valid.subarray(0, 33), 1, 2, 3, 4, 5]);
    expect(await isEmbeddablePng(garbage)).toBe(false);
    expect(await isEmbeddablePng(valid.subarray(0, 20))).toBe(false);
  });
});

/** A page's content streams, decoded to their operators. */
function contentStreams(page: PDFPage) {
  const contents = page.node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  return refs.map((ref) => {
    const stream = page.doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) return "";
    return new TextDecoder("latin1").decode(
      decodePDFRawStream(stream).decode(),
    );
  });
}

async function samplePdf() {
  const document = await PDFDocument.create();
  document.addPage([612, 792]);
  document.addPage([612, 792]).setRotation(degrees(90));
  return document.save();
}

/** A 2 × 1 PNG, built with the same library that embeds signatures. */
async function pngBytes() {
  return Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNgYGD4z8DAwMAAAA0ABQHsHwEAAAAASUVORK5CYII=",
    ),
    (character) => character.charCodeAt(0),
  );
}
