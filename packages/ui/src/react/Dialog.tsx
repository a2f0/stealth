import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "./Button";
import { Field } from "./Field";

interface DialogText {
  /** The question itself, such as "Delete Acme, Inc.?". */
  title: string;
  /** What answering yes will do. Line breaks in a string are kept. */
  message?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` marks a confirmation that deletes, removes, or revokes. */
  tone?: "danger" | "primary";
}

export interface ConfirmOptions extends DialogText {
  /** Text, such as an organization's name, to type before confirming. */
  typeToConfirm?: string;
}

export interface PromptOptions extends DialogText {
  label: string;
  defaultValue?: string;
  maxLength?: number;
  /** A textarea for a sentence or two, such as a reason. */
  multiline?: boolean;
  placeholder?: string;
  /** Keeps the confirm button disabled until the answer has text. */
  required?: boolean;
}

interface DialogRequest {
  id: number;
  options: ConfirmOptions & Partial<PromptOptions>;
  prompt: boolean;
  resolve: (answer: string | null) => void;
}

let requests: DialogRequest[] = [];
let nextId = 0;
const listeners = new Set<() => void>();

function publish(next: DialogRequest[]) {
  requests = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function ask(options: DialogRequest["options"], prompt: boolean) {
  if (listeners.size === 0) {
    return Promise.reject(new Error("DialogHost is not mounted."));
  }
  return new Promise<string | null>((resolve) => {
    nextId += 1;
    publish([...requests, { id: nextId, options, prompt, resolve }]);
  });
}

/** Asks a yes-or-no question in the app's own dialog; true means confirmed. */
export function confirmDialog(options: ConfirmOptions) {
  return ask(options, false).then((answer) => answer !== null);
}

/** Asks for a short answer; null means the person cancelled. */
export function promptDialog(options: PromptOptions) {
  return ask(options, true);
}

/**
 * Shows the dialogs that `confirmDialog` and `promptDialog` request, one at a
 * time and in order. Mount it once, at the root of the app.
 */
export function DialogHost() {
  const current = useSyncExternalStore(
    subscribe,
    () => requests[0],
    () => undefined,
  );
  if (!current) return null;
  return (
    <RequestDialog
      key={current.id}
      onAnswer={(answer) => {
        publish(requests.filter((request) => request !== current));
        current.resolve(answer);
      }}
      request={current}
    />
  );
}

function RequestDialog({
  onAnswer,
  request: { options, prompt },
}: {
  onAnswer: (answer: string | null) => void;
  request: DialogRequest;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const [value, setValue] = useState(options.defaultValue ?? "");
  const titleId = useId();
  const messageId = useId();
  const typed = options.typeToConfirm;
  const takesInput = prompt || typed !== undefined;
  const danger = options.tone === "danger";
  let ready = true;
  if (typed !== undefined) ready = value.trim() === typed.trim();
  else if (prompt && options.required) ready = Boolean(value.trim());

  useEffect(() => {
    const element = dialog.current;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (element && !element.open) element.showModal();
    // An answer field first; otherwise the safer choice for a destructive one.
    (takesInput ? input : danger ? cancel : confirm).current?.focus();
    return () => {
      if (element?.open) element.close();
      opener?.focus();
    };
  }, [danger, takesInput]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (ready) onAnswer(prompt ? value : "");
  }

  return (
    <dialog
      aria-describedby={options.message ? messageId : undefined}
      aria-labelledby={titleId}
      className="dialog"
      onCancel={(event) => {
        // Escape answers no; the host closes the dialog when it unmounts.
        event.preventDefault();
        onAnswer(null);
      }}
      ref={dialog}
      role="alertdialog"
    >
      <form className="dialogFrame" onSubmit={submit}>
        <h2 className="dialogTitle" id={titleId}>
          {options.title}
        </h2>
        {options.message && (
          <div className="dialogMessage" id={messageId}>
            {options.message}
          </div>
        )}
        {takesInput && (
          <AnswerField
            input={input}
            onChange={setValue}
            options={options}
            value={value}
          />
        )}
        <div className="dialogActions">
          <Button onClick={() => onAnswer(null)} ref={cancel} variant="ghost">
            {options.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            disabled={!ready}
            ref={confirm}
            type="submit"
            variant={danger ? "danger" : "primary"}
          >
            {options.confirmLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}

function AnswerField({
  input,
  onChange,
  options,
  value,
}: {
  input: RefObject<(HTMLInputElement & HTMLTextAreaElement) | null>;
  onChange: (value: string) => void;
  options: DialogRequest["options"];
  value: string;
}) {
  const typed = options.typeToConfirm;
  const shared = {
    maxLength: options.maxLength,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(event.target.value),
    placeholder: options.placeholder,
    ref: input,
    value,
  };
  return (
    <Field
      label={
        typed === undefined ? (
          options.label
        ) : (
          <>
            Type <strong>{typed}</strong> to confirm
          </>
        )
      }
    >
      {options.multiline ? (
        <textarea className="textarea" rows={3} {...shared} />
      ) : (
        <input
          autoComplete="off"
          className="input"
          spellCheck={typed === undefined}
          type="text"
          {...shared}
        />
      )}
    </Field>
  );
}
