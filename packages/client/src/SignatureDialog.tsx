import { Button, Field, Icon } from "@tearleads/ui/react";
import { type PointerEvent, useEffect, useRef, useState } from "react";

type Mode = "initials" | "signature";

const ink = "#1d1f22";
const canvasSizes: Record<Mode, { height: number; width: number }> = {
  initials: { height: 160, width: 260 },
  signature: { height: 160, width: 640 },
};

/**
 * Adopts a signature or initials, typed in a script face or drawn, as a PNG
 * data URL for the server to stamp into the document.
 */
export function SignatureDialog({
  defaultText,
  mode,
  onAdopt,
  onClose,
}: {
  defaultText: string;
  mode: Mode;
  onAdopt: (dataUrl: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<"draw" | "type">("type");
  const [text, setText] = useState(defaultText);
  const [drawing, setDrawing] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  async function adopt() {
    setError(undefined);
    let image = drawing;
    if (tab === "type") {
      if (!text.trim()) return setError("Type your name.");
      image = await renderTyped(text.trim(), mode);
    } else if (!image) {
      return setError("Draw your signature in the box.");
    }
    // Closing first returns focus to the field that opened the dialog.
    dialog.current?.close();
    onAdopt(image);
  }

  const noun = mode === "signature" ? "signature" : "initials";
  return (
    <dialog
      aria-label={`Adopt your ${noun}`}
      className="signatureDialog"
      onClose={onClose}
      ref={dialog}
    >
      <form
        className="signatureDialogFrame"
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void adopt();
        }}
      >
        <header className="signatureDialogHeader">
          <h2 className="cardTitle">Adopt your {noun}</h2>
          <Button
            aria-label="Close"
            icon="close"
            iconOnly
            onClick={() => dialog.current?.close()}
            size="sm"
            variant="ghost"
          />
        </header>
        <nav aria-label="Signature style" className="segmented">
          {(["type", "draw"] as const).map((option) => (
            <button
              aria-pressed={tab === option}
              key={option}
              onClick={() => {
                setTab(option);
                // The pad starts blank again, so forget any earlier drawing.
                setDrawing(null);
              }}
              type="button"
            >
              <Icon name={option === "type" ? "type" : "edit"} size={16} />
              {option === "type" ? "Type" : "Draw"}
            </button>
          ))}
        </nav>
        {tab === "type" ? (
          <>
            <Field label={mode === "signature" ? "Full name" : "Initials"}>
              <input
                className="input"
                maxLength={mode === "signature" ? 80 : 6}
                onChange={(event) => setText(event.target.value)}
                value={text}
              />
            </Field>
            <p aria-hidden="true" className="signaturePreview">
              {text || " "}
            </p>
          </>
        ) : (
          <SignaturePad mode={mode} onChange={setDrawing} />
        )}
        {error && <p className="fieldError">{error}</p>}
        <p className="contractHint">
          By adopting this {noun}, you agree it is your electronic {noun} and
          has the same effect as one written by hand.
        </p>
        <footer className="signatureDialogFooter">
          <Button onClick={() => dialog.current?.close()} variant="ghost">
            Cancel
          </Button>
          <Button icon="signature" type="submit" variant="primary">
            Adopt and sign
          </Button>
        </footer>
      </form>
    </dialog>
  );
}

/** A drawing surface; reports a PNG once something has been drawn. */
function SignaturePad({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (dataUrl: string | null) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  // A tap without movement draws nothing, so it must not count as a drawing.
  const drew = useRef(false);
  const size = canvasSizes[mode];
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = 4;
    context.strokeStyle = ink;
  }, []);

  function point(event: PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * size.width,
      y: ((event.clientY - rect.top) / rect.height) * size.height,
    };
  }
  function start(event: PointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    last.current = point(event);
  }
  function move(event: PointerEvent<HTMLCanvasElement>) {
    const context = canvas.current?.getContext("2d");
    if (!context || !last.current) return;
    const next = point(event);
    context.beginPath();
    context.moveTo(last.current.x, last.current.y);
    context.lineTo(next.x, next.y);
    context.stroke();
    last.current = next;
    drew.current = true;
  }
  function end() {
    if (!last.current) return;
    last.current = null;
    if (drew.current) onChange(canvas.current?.toDataURL("image/png") ?? null);
  }
  function clear() {
    const element = canvas.current;
    element?.getContext("2d")?.clearRect(0, 0, size.width, size.height);
    drew.current = false;
    onChange(null);
  }
  return (
    <div className="signaturePad">
      <canvas
        aria-label="Draw your signature"
        className="signaturePadCanvas"
        data-theme="light"
        height={size.height}
        onPointerCancel={end}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        ref={canvas}
        role="img"
        style={{ aspectRatio: `${size.width} / ${size.height}` }}
        width={size.width}
      />
      <Button icon="eraser" onClick={clear} size="sm" variant="ghost">
        Clear
      </Button>
    </div>
  );
}

/** Draws typed text in the script face onto a transparent PNG. */
async function renderTyped(text: string, mode: Mode) {
  const { height, width } = canvasSizes[mode];
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Signatures can't be drawn in this browser.");
  let size = mode === "signature" ? 84 : 96;
  const face = (points: number) =>
    `italic ${points}px "Instrument Serif", serif`;
  await document.fonts.load(face(size), text).catch(() => undefined);
  context.font = face(size);
  while (size > 24 && context.measureText(text).width > width - 24) {
    size -= 4;
    context.font = face(size);
  }
  context.fillStyle = ink;
  context.textBaseline = "middle";
  context.fillText(text, 12, height / 2);
  return canvas.toDataURL("image/png");
}
