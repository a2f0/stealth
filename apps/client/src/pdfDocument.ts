import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

type Pdfjs = typeof import("pdfjs-dist");

let library: Promise<Pdfjs> | undefined;

/** pdf.js is large, so it and its worker load on the first preview. */
function loadPdfjs() {
  library ??= Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  });
  return library;
}

/**
 * Starts parsing an untrusted PDF for display only; nothing here enables
 * scripting or XFA forms. Destroy the returned task to release the document
 * and its worker. Runtime assets come from /pdfjs/ (see vite.config.ts).
 */
export async function openPdf(data: ArrayBuffer) {
  const pdfjs = await loadPdfjs();
  const assets = new URL("/pdfjs/", window.location.origin).href;
  return pdfjs.getDocument({
    cMapPacked: true,
    cMapUrl: `${assets}cmaps/`,
    data,
    enableXfa: false,
    iccUrl: `${assets}iccs/`,
    standardFontDataUrl: `${assets}standard_fonts/`,
    wasmUrl: `${assets}wasm/`,
  });
}

/**
 * Draws one page into a canvas at the given CSS width, sharpened for the
 * display's pixel ratio. Cancel the returned task when the canvas goes away.
 */
export async function renderPdfPage(
  document: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  cssWidth: number,
): Promise<RenderTask> {
  const page = await document.getPage(pageNumber);
  const scale = cssWidth / page.getViewport({ scale: 1 }).width;
  const viewport = page.getViewport({
    scale: scale * (window.devicePixelRatio || 1),
  });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  return page.render({ canvas, viewport });
}

export function isRenderCancellation(error: unknown) {
  return error instanceof Error && error.name === "RenderingCancelledException";
}
