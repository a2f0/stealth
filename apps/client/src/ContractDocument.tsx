import { LoadingState } from "@tearleads/ui/react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { isRenderCancellation, openPdf, renderPdfPage } from "./pdfDocument";

/** A page's size in PDF points as displayed, after any /Rotate. */
export interface PageSize {
  height: number;
  number: number;
  width: number;
}

interface LoadedPdf {
  document: PDFDocumentProxy;
  pages: PageSize[];
}

/**
 * Renders every page of a PDF with an overlay layer above each one. Overlays
 * position content with percentages, so it lines up at any rendered width.
 */
export function ContractPages({
  load,
  renderOverlay,
}: {
  load: () => Promise<ArrayBuffer>;
  renderOverlay: (page: PageSize) => ReactNode;
}) {
  const pdf = useContractPdf(load);
  if (pdf.failed) {
    return (
      <p className="contractPagesMessage">
        This document could not be displayed.
      </p>
    );
  }
  if (!pdf.loaded) return <LoadingState label="Opening document…" />;
  const { document, pages } = pdf.loaded;
  return (
    <div className="contractPages">
      {pages.map((page) => (
        <section
          aria-label={`Page ${page.number} of ${pages.length}`}
          className="contractPage"
          key={page.number}
          style={{ aspectRatio: `${page.width} / ${page.height}` }}
        >
          <LazyPageCanvas document={document} pageNumber={page.number} />
          <div className="contractPageOverlay">{renderOverlay(page)}</div>
        </section>
      ))}
    </div>
  );
}

function useContractPdf(load: () => Promise<ArrayBuffer>) {
  const [state, setState] = useState<{ failed?: boolean; loaded?: LoadedPdf }>(
    {},
  );
  // The loader changes identity on every render; load once per mount.
  const loader = useRef(load);
  useEffect(() => {
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    loader
      .current()
      .then(openPdf)
      .then((started) => {
        task = started;
        if (!active) void started.destroy();
        return started.promise;
      })
      .then(async (document) => {
        const pages: PageSize[] = [];
        for (let number = 1; number <= document.numPages; number += 1) {
          const viewport = (await document.getPage(number)).getViewport({
            scale: 1,
          });
          pages.push({
            height: viewport.height,
            number,
            width: viewport.width,
          });
        }
        if (active) setState({ loaded: { document, pages } });
      })
      .catch(() => {
        if (active) setState({ failed: true });
      });
    return () => {
      active = false;
      void task?.destroy();
    };
  }, []);
  return state;
}

/** The widest a page renders in device pixels, to bound canvas memory. */
const maxCanvasPixels = 2000;

/**
 * Renders a page while it is near the viewport, at the width it is shown, and
 * frees its canvas once it is far away so long documents fit in memory.
 */
function LazyPageCanvas({
  document,
  pageNumber,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry) setVisible(entry.isIntersecting);
      },
      { rootMargin: "1200px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    if (!visible) {
      element.width = 0;
      element.height = 0;
      return;
    }
    let active = true;
    let task: RenderTask | undefined;
    const width = Math.min(
      element.clientWidth || 800,
      1200,
      maxCanvasPixels / (window.devicePixelRatio || 1),
    );
    renderPdfPage(document, pageNumber, element, width)
      .then((started) => {
        task = started;
        if (!active) started.cancel();
        return started.promise;
      })
      .catch((error: unknown) => {
        if (!isRenderCancellation(error)) console.error(error);
      });
    return () => {
      active = false;
      task?.cancel();
    };
  }, [document, pageNumber, visible]);
  return <canvas className="contractPageCanvas" ref={canvas} />;
}

/** Percent-based absolute placement for a field box. */
export function boxStyle(box: {
  height: number;
  width: number;
  x: number;
  y: number;
}) {
  return {
    height: `${box.height * 100}%`,
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.width * 100}%`,
  };
}
