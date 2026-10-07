import { Button, ButtonLink, Icon } from "@tearleads/ui/react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { fetchApi } from "./apiVersion";
import { countLabel, formatBytes } from "./labels";
import { isRenderCancellation, openPdf, renderPdfPage } from "./pdfDocument";

type PreviewKind = "image" | "pdf";

interface PreviewAttachment {
  filename: string;
  size: number;
}

interface PdfState {
  document?: PDFDocumentProxy | undefined;
  failed?: boolean | undefined;
  loading?: boolean | undefined;
}

/** Larger PDFs only download when someone opens the preview. */
const automaticPdfBytes = 10 * 1024 * 1024;
const thumbnailWidth = 240;
const viewerMaxWidth = 960;

/**
 * A thumbnail of an image or the first page of a PDF that opens a larger,
 * paged preview.
 */
export function AttachmentPreviewTile({
  attachment,
  kind,
  url,
}: {
  attachment: PreviewAttachment;
  kind: PreviewKind;
  url: string;
}) {
  const [viewing, setViewing] = useState(false);
  // Stays true once set so closing the viewer keeps the parsed document.
  const [pdfRequested, setPdfRequested] = useState(
    attachment.size <= automaticPdfBytes,
  );
  const pdf = usePdfDocument(url, kind === "pdf" && pdfRequested);
  const detail =
    kind === "pdf"
      ? pdf.document
        ? countLabel(pdf.document.numPages, "page")
        : "PDF"
      : "Image";
  return (
    <figure className="previewTile">
      <button
        aria-label={`Preview ${attachment.filename}`}
        className="previewTileButton"
        onClick={() => {
          setPdfRequested(true);
          setViewing(true);
        }}
        type="button"
      >
        {kind === "image" ? (
          <ImageThumbnail url={url} />
        ) : (
          <PdfThumbnail pdf={pdf} />
        )}
      </button>
      <figcaption className="previewTileCaption">
        <span className="previewTileText">
          <span className="previewTileName">{attachment.filename}</span>
          <span className="previewTileMeta">
            {detail} · {formatBytes(attachment.size)}
          </span>
        </span>
        <ButtonLink
          aria-label={`Download ${attachment.filename}`}
          href={url}
          icon="download"
          iconOnly
          size="sm"
          variant="ghost"
        />
      </figcaption>
      {viewing && (
        <PreviewDialog
          attachment={attachment}
          kind={kind}
          onClose={() => setViewing(false)}
          pdf={pdf}
          url={url}
        />
      )}
    </figure>
  );
}

function ImageThumbnail({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <PreviewPlaceholder icon="image" label="No preview" />;
  return (
    <img
      alt=""
      className="previewTileImage"
      decoding="async"
      loading="lazy"
      onError={() => setFailed(true)}
      src={url}
    />
  );
}

function PdfThumbnail({ pdf }: { pdf: PdfState }) {
  if (pdf.document) {
    return (
      <PdfPageCanvas
        className="previewTileCanvas"
        document={pdf.document}
        pageNumber={1}
        width={thumbnailWidth}
      />
    );
  }
  if (pdf.loading) {
    return (
      <span className="previewPlaceholder">
        <span aria-hidden="true" className="spinner" />
      </span>
    );
  }
  return (
    <PreviewPlaceholder
      icon="document"
      label={pdf.failed ? "No preview" : "PDF"}
    />
  );
}

function PreviewPlaceholder({
  icon,
  label,
}: {
  icon: "document" | "image";
  label: string;
}) {
  return (
    <span className="previewPlaceholder">
      <Icon name={icon} size={28} strokeWidth={1.5} />
      <span className="previewPlaceholderLabel">{label}</span>
    </span>
  );
}

function PreviewDialog({
  attachment,
  kind,
  onClose,
  pdf,
  url,
}: {
  attachment: PreviewAttachment;
  kind: PreviewKind;
  onClose: () => void;
  pdf: PdfState;
  url: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const pageCount = pdf.document?.numPages ?? 0;
  // Unmounting removes the dialog from the top layer, so there is no cleanup:
  // closing it there would fire onClose after a StrictMode remount.
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  // A click on the dialog itself, rather than its content, hit the backdrop.
  const closeFromBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes a modal dialog natively.
    <dialog
      aria-label={`Preview of ${attachment.filename}`}
      className="previewDialog"
      onClick={closeFromBackdrop}
      onClose={onClose}
      ref={dialog}
    >
      <div className="previewDialogFrame">
        <header className="previewDialogHeader">
          <strong className="previewDialogTitle">{attachment.filename}</strong>
          {pageCount > 1 && (
            <PageControls
              onChange={setPageNumber}
              pageCount={pageCount}
              pageNumber={pageNumber}
            />
          )}
          <div className="previewDialogActions">
            <ButtonLink href={url} icon="download" size="sm">
              Download
            </ButtonLink>
            <Button
              aria-label="Close preview"
              icon="close"
              iconOnly
              onClick={() => dialog.current?.close()}
              size="sm"
              variant="ghost"
            />
          </div>
        </header>
        <div className="previewDialogBody">
          {kind === "image" ? (
            <img alt={attachment.filename} className="previewImage" src={url} />
          ) : (
            <PdfViewerPage pageNumber={pageNumber} pdf={pdf} />
          )}
        </div>
      </div>
    </dialog>
  );
}

function PageControls({
  onChange,
  pageCount,
  pageNumber,
}: {
  onChange: (pageNumber: number) => void;
  pageCount: number;
  pageNumber: number;
}) {
  return (
    <div className="previewPages">
      <Button
        aria-label="Previous page"
        disabled={pageNumber <= 1}
        icon="chevronLeft"
        iconOnly
        onClick={() => onChange(pageNumber - 1)}
        size="sm"
        variant="ghost"
      />
      <span aria-live="polite" className="previewPageNumber">
        Page {pageNumber} of {pageCount}
      </span>
      <Button
        aria-label="Next page"
        disabled={pageNumber >= pageCount}
        icon="chevronRight"
        iconOnly
        onClick={() => onChange(pageNumber + 1)}
        size="sm"
        variant="ghost"
      />
    </div>
  );
}

function PdfViewerPage({
  pageNumber,
  pdf,
}: {
  pageNumber: number;
  pdf: PdfState;
}) {
  if (pdf.document) {
    return (
      <PdfPageCanvas
        className="previewPdfPage"
        document={pdf.document}
        key={pageNumber}
        pageNumber={pageNumber}
        width={Math.min(window.innerWidth - 64, viewerMaxWidth)}
      />
    );
  }
  if (pdf.failed) {
    return (
      <p className="previewMessage">
        This PDF could not be previewed. Download it to open it instead.
      </p>
    );
  }
  return (
    <p className="previewMessage">
      <span aria-hidden="true" className="spinner" /> Opening PDF…
    </p>
  );
}

function PdfPageCanvas({
  className,
  document,
  pageNumber,
  width,
}: {
  className: string;
  document: PDFDocumentProxy;
  pageNumber: number;
  width: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let active = true;
    let task: RenderTask | undefined;
    renderPdfPage(document, pageNumber, element, width)
      .then((started) => {
        task = started;
        if (!active) started.cancel();
        return started.promise;
      })
      .catch((error: unknown) => {
        if (active && !isRenderCancellation(error)) setFailed(true);
      });
    return () => {
      active = false;
      task?.cancel();
    };
  }, [document, pageNumber, width]);
  if (failed) {
    return <PreviewPlaceholder icon="document" label="No preview" />;
  }
  return (
    <canvas
      aria-label={`Page ${pageNumber}`}
      className={className}
      ref={canvas}
      role="img"
    />
  );
}

/** Downloads and parses a PDF once `enabled` becomes true. */
function usePdfDocument(url: string, enabled: boolean): PdfState {
  const [state, setState] = useState<PdfState>({});
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    setState({ loading: true });
    fetchApi(url, { credentials: "include" })
      .then((response) => {
        if (!response.ok) throw new Error("The PDF could not be downloaded.");
        return response.arrayBuffer();
      })
      .then(openPdf)
      .then((started) => {
        task = started;
        if (!active) void started.destroy();
        return started.promise;
      })
      .then((document) => {
        if (active) setState({ document });
      })
      .catch(() => {
        if (active) setState({ failed: true });
      });
    return () => {
      active = false;
      void task?.destroy();
    };
  }, [enabled, url]);
  return state;
}
