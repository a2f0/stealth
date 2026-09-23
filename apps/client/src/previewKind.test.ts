import { describe, expect, it } from "bun:test";
import { previewKindFor } from "./previewKind";

describe("previewKindFor", () => {
  it("previews PDFs and raster images by content type", () => {
    expect(
      previewKindFor({ contentType: "application/pdf", filename: "a" }),
    ).toBe("pdf");
    expect(
      previewKindFor({
        contentType: "Application/PDF; name=invoice.pdf",
        filename: "invoice",
      }),
    ).toBe("pdf");
    expect(
      previewKindFor({ contentType: "image/png", filename: "a.bin" }),
    ).toBe("image");
    expect(
      previewKindFor({ contentType: "image/jpeg", filename: "scan" }),
    ).toBe("image");
  });

  it("falls back to the filename for generic content types", () => {
    expect(
      previewKindFor({
        contentType: "application/octet-stream",
        filename: "Receipt.PDF",
      }),
    ).toBe("pdf");
    expect(previewKindFor({ contentType: "", filename: "photo.JPG" })).toBe(
      "image",
    );
    expect(
      previewKindFor({
        contentType: "application/octet-stream",
        filename: "archive.zip",
      }),
    ).toBeNull();
  });

  it("does not preview SVG, HEIC, or mislabeled documents", () => {
    expect(
      previewKindFor({ contentType: "image/svg+xml", filename: "a.svg" }),
    ).toBeNull();
    expect(
      previewKindFor({ contentType: "image/heic", filename: "a.heic" }),
    ).toBeNull();
    expect(
      previewKindFor({ contentType: "text/html", filename: "invoice.pdf" }),
    ).toBeNull();
    expect(
      previewKindFor({
        contentType: "application/octet-stream",
        filename: ".png",
      }),
    ).toBeNull();
  });
});
