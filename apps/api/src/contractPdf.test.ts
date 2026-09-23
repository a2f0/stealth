import { describe, expect, it } from "bun:test";
import { degrees, PDFDocument } from "pdf-lib";
import {
  type Certificate,
  InvalidPdfError,
  inspectPdf,
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
    expect(await sha256Hex(stamped)).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex(stamped)).not.toBe(await sha256Hex(original));
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
