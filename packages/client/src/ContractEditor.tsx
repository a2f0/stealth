import { Banner, Button, Card, cx, Field, Icon } from "@tearleads/ui/react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { boxStyle, ContractPages, type PageSize } from "./ContractDocument";
import {
  clampBox,
  fieldTypeLabel,
  fieldTypes,
  initialsFor,
  localDate,
  nudgeBox,
  placeNewField,
  recipientTone,
  reminderOptions,
} from "./contractFields";
import {
  type ContractDetail,
  contractDocumentUrl,
  type DraftField,
  type DraftInput,
  type DraftRecipient,
  deleteContract,
  type FieldType,
  saveContractDraft,
  sendContract,
} from "./contractsApi";

type Editor = ReturnType<typeof useDraftEditor>;

/** How long after the last edit a draft saves itself. */
const autosaveDelayMs = 1200;
const fieldHelpId = "contractFieldHelp";

/** Prepares a draft: details, signers, and fields placed on the document. */
export function ContractEditor({
  contract,
  onChanged,
  onDeleted,
}: {
  contract: ContractDetail;
  onChanged: (contract: ContractDetail) => void;
  onDeleted: () => void;
}) {
  const editor = useDraftEditor(contract, onChanged, onDeleted);
  return (
    <div className="contractEditor">
      <p className="srOnly" id={fieldHelpId}>
        Arrow keys move the field; hold Shift to move it further. Delete removes
        it.
      </p>
      <aside className="contractEditorPanel">
        {editor.error && <Banner tone="danger">{editor.error}</Banner>}
        {editor.notice && <Banner tone="success">{editor.notice}</Banner>}
        <DraftDetails editor={editor} />
        <DraftSigners editor={editor} />
        <FieldToolbox editor={editor} />
        <SelectedField editor={editor} />
        <DraftActions editor={editor} />
      </aside>
      <div className="contractEditorDocument">
        <ContractPages
          load={() => fetchDocument(contract.id)}
          renderOverlay={(page) => (
            <EditorOverlay editor={editor} page={page} />
          )}
        />
      </div>
    </div>
  );
}

function useDraftEditor(
  contract: ContractDetail,
  onChanged: (contract: ContractDetail) => void,
  onDeleted: () => void,
) {
  const [draft, setDraft] = useState(() => draftFrom(contract));
  const [dirty, setDirty] = useState(false);
  const [activeKey, setActiveKey] = useState(draft.recipients[0]?.key);
  const [tool, setTool] = useState<FieldType | null>(null);
  const [selectedKey, setSelectedKey] = useState<string>();
  // Counts edits, so a save marks the draft clean only if nothing changed
  // while it was in flight.
  const revision = useRef(0);
  const pageSizes = useRef(new Map<number, PageSize>());
  // The field just placed from the keyboard or pointer, focused once mounted.
  const justPlaced = useRef<string | null>(null);
  const update = useCallback((change: (draft: DraftInput) => DraftInput) => {
    revision.current += 1;
    setDraft(change);
    setDirty(true);
  }, []);
  const saving = useDraftSaving({
    contract,
    dirty,
    draft,
    onChanged,
    onDeleted,
    revision,
    setDirty,
  });
  const active = draft.recipients.some(({ key }) => key === activeKey)
    ? activeKey
    : draft.recipients[0]?.key;
  const fields = fieldActions(update, setSelectedKey, justPlaced);
  return {
    ...saving,
    ...recipientActions(draft, update, setActiveKey),
    ...fields,
    activeKey: active,
    dirty,
    draft,
    justPlaced,
    pageCount: contract.document.pageCount,
    pageSizes: pageSizes.current,
    /** Keyboard placement: the middle of page 1, then arrow keys and Page. */
    placeFromKeyboard: (type: FieldType) => {
      if (!active) return;
      const page = pageSizes.current.get(1) ?? letterPage;
      fields.addField({
        ...placeNewField(type, 1, { x: 0.5, y: 0.5 }, page),
        key: crypto.randomUUID(),
        label: null,
        recipientKey: active,
        required: true,
        type,
      });
      setTool(null);
    },
    selectedKey,
    setActiveKey,
    setSelectedKey,
    setTool,
    tool,
    update,
  };
}

const letterPage: PageSize = { height: 792, number: 1, width: 612 };

/**
 * Saves the draft a moment after each edit, when leaving the page, and on
 * request, and guards against closing the tab with unsaved edits.
 */
function useDraftSaving({
  contract,
  dirty,
  draft,
  onChanged,
  onDeleted,
  revision,
  setDirty,
}: {
  contract: ContractDetail;
  dirty: boolean;
  draft: DraftInput;
  onChanged: (contract: ContractDetail) => void;
  onDeleted: () => void;
  revision: { current: number };
  setDirty: (dirty: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const unsaved = useRef<DraftInput | null>(null);
  const contractId = contract.id;
  // A cleared title still saves, under the document's name, so edits made
  // meanwhile are never skipped.
  const untitled =
    contract.document.filename.replace(/\.pdf$/i, "") || "Untitled";
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }, []);
  const saveDraft = useCallback(
    async (value: DraftInput) => {
      const saving = revision.current;
      const titled = value.title.trim() ? value : { ...value, title: untitled };
      onChanged(await saveContractDraft(contractId, titled));
      if (revision.current !== saving) return false;
      setDirty(false);
      return true;
    },
    [contractId, onChanged, revision, setDirty, untitled],
  );

  const autosave = dirty && !busy && !stalled;
  useEffect(() => {
    if (!autosave) return;
    const timer = window.setTimeout(() => {
      const started = revision.current;
      void run(async () => {
        try {
          await saveDraft(draft);
        } catch (cause) {
          // Wait for the next edit rather than retrying a rejected draft,
          // unless it was already edited while this save was in flight.
          if (revision.current === started) setStalled(true);
          throw cause;
        }
      });
    }, autosaveDelayMs);
    return () => window.clearTimeout(timer);
  }, [autosave, draft, revision, run, saveDraft]);
  useEffect(() => {
    unsaved.current = dirty ? draft : null;
    setStalled(false);
  }, [dirty, draft]);
  // Leaving the page saves edits the autosave has not reached yet.
  useEffect(
    () => () => {
      const value = unsaved.current;
      if (value) {
        const titled = value.title.trim()
          ? value
          : { ...value, title: untitled };
        void saveContractDraft(contractId, titled).catch(() => undefined);
      }
    },
    [contractId, untitled],
  );
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy, dirty]);

  return {
    busy,
    error,
    notice,
    remove: () => {
      if (!window.confirm(`Delete “${contract.title}”? This can't be undone.`))
        return;
      void run(async () => {
        await deleteContract(contractId);
        unsaved.current = null;
        onDeleted();
      });
    },
    save: () =>
      run(async () => {
        if (await saveDraft(draft)) setNotice("Draft saved.");
      }),
    send: () =>
      run(async () => {
        if (dirty && !(await saveDraft(draft))) {
          setNotice("You edited the draft while it saved. Send it again.");
          return;
        }
        onChanged(await sendContract(contractId));
      }),
  };
}

function recipientActions(
  draft: DraftInput,
  update: (change: (draft: DraftInput) => DraftInput) => void,
  setActiveKey: (key: string) => void,
) {
  return {
    addRecipient: () => {
      const key = crypto.randomUUID();
      const routingOrder =
        Math.max(
          0,
          ...draft.recipients.map(({ routingOrder }) => routingOrder),
        ) + 1;
      update((current) => ({
        ...current,
        recipients: [
          ...current.recipients,
          { email: "", key, name: "", routingOrder },
        ],
      }));
      setActiveKey(key);
    },
    changeRecipient: (key: string, change: Partial<DraftRecipient>) =>
      update((current) => ({
        ...current,
        recipients: current.recipients.map((recipient) =>
          recipient.key === key ? { ...recipient, ...change } : recipient,
        ),
      })),
    removeRecipient: (key: string) =>
      update((current) => ({
        ...current,
        fields: current.fields.filter(
          ({ recipientKey }) => recipientKey !== key,
        ),
        recipients: current.recipients.filter(
          (recipient) => recipient.key !== key,
        ),
      })),
  };
}

function fieldActions(
  update: (change: (draft: DraftInput) => DraftInput) => void,
  setSelectedKey: (key: string | undefined) => void,
  justPlaced: { current: string | null },
) {
  return {
    addField: (field: DraftField) => {
      update((current) => ({ ...current, fields: [...current.fields, field] }));
      setSelectedKey(field.key);
      justPlaced.current = field.key;
    },
    changeField: (key: string, change: Partial<DraftField>) =>
      update((current) => ({
        ...current,
        fields: current.fields.map((field) =>
          field.key === key ? { ...field, ...change } : field,
        ),
      })),
    removeField: (key: string) => {
      update((current) => ({
        ...current,
        fields: current.fields.filter((field) => field.key !== key),
      }));
      setSelectedKey(undefined);
    },
  };
}

function DraftDetails({ editor }: { editor: Editor }) {
  const { draft, update } = editor;
  const set = <Key extends keyof DraftInput>(
    key: Key,
    value: DraftInput[Key],
  ) => update((current) => ({ ...current, [key]: value }));
  return (
    <Card title="Details">
      <div className="stack stackMd">
        <Field label="Title">
          <input
            className="input"
            maxLength={200}
            onChange={(event) => set("title", event.target.value)}
            value={draft.title}
          />
        </Field>
        <Field
          hint="Included in the email to every signer."
          label="Message"
          optional
        >
          <textarea
            className="textarea"
            maxLength={2000}
            onChange={(event) => set("message", event.target.value)}
            rows={3}
            value={draft.message}
          />
        </Field>
        <div className="contractDetailRow">
          <Field label="Due date" optional>
            <input
              className="input"
              min={localDate()}
              onChange={(event) => set("dueDate", event.target.value || null)}
              type="date"
              value={draft.dueDate ?? ""}
            />
          </Field>
          <Field label="Reminders">
            <select
              className="select"
              onChange={(event) =>
                set(
                  "reminderIntervalDays",
                  event.target.value ? Number(event.target.value) : null,
                )
              }
              value={draft.reminderIntervalDays ?? ""}
            >
              {reminderOptions.map((option) => (
                <option key={option.label} value={option.value ?? ""}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
    </Card>
  );
}

function DraftSigners({ editor }: { editor: Editor }) {
  const { draft, update } = editor;
  const sequential = draft.signingOrder === "sequential";
  return (
    <Card
      actions={
        <Button
          icon="add"
          onClick={editor.addRecipient}
          size="sm"
          variant="ghost"
        >
          Add signer
        </Button>
      }
      title="Signers"
    >
      <div className="stack stackMd">
        <nav aria-label="Signing order" className="segmented segmentedFill">
          {(["parallel", "sequential"] as const).map((order) => (
            <button
              aria-pressed={draft.signingOrder === order}
              key={order}
              onClick={() =>
                update((current) => ({ ...current, signingOrder: order }))
              }
              type="button"
            >
              {order === "parallel" ? "Any order" : "One after another"}
            </button>
          ))}
        </nav>
        {draft.recipients.length === 0 && (
          <p className="contractHint">Add everyone who needs to sign.</p>
        )}
        <ol className="contractSigners">
          {draft.recipients.map((recipient, index) => (
            <SignerRow
              editor={editor}
              index={index}
              key={recipient.key}
              recipient={recipient}
              sequential={sequential}
            />
          ))}
        </ol>
      </div>
    </Card>
  );
}

function SignerRow({
  editor,
  index,
  recipient,
  sequential,
}: {
  editor: Editor;
  index: number;
  recipient: DraftRecipient;
  sequential: boolean;
}) {
  const fieldCount = editor.draft.fields.filter(
    ({ recipientKey }) => recipientKey === recipient.key,
  ).length;
  const label = recipient.name || `Signer ${index + 1}`;
  return (
    <li className={cx("contractSigner", recipientTone(index))}>
      <span aria-hidden="true" className="contractSignerSwatch" />
      <div className="contractSignerFields">
        <input
          aria-label={`Signer ${index + 1} name`}
          className="input inputSm"
          maxLength={120}
          onChange={(event) =>
            editor.changeRecipient(recipient.key, { name: event.target.value })
          }
          placeholder="Full name"
          value={recipient.name}
        />
        <input
          aria-label={`Signer ${index + 1} email`}
          className="input inputSm"
          maxLength={254}
          onChange={(event) =>
            editor.changeRecipient(recipient.key, { email: event.target.value })
          }
          placeholder="name@example.com"
          type="email"
          value={recipient.email}
        />
        <span className="contractSignerMeta">
          {sequential && (
            <label className="contractSignerOrder">
              Signs
              <input
                aria-label={`${label} signs in position`}
                className="input inputSm"
                max={20}
                min={1}
                onChange={(event) =>
                  editor.changeRecipient(recipient.key, {
                    routingOrder: Math.max(1, Number(event.target.value) || 1),
                  })
                }
                type="number"
                value={recipient.routingOrder}
              />
            </label>
          )}
          {fieldCount} {fieldCount === 1 ? "field" : "fields"}
        </span>
      </div>
      <Button
        aria-label={`Remove ${label}`}
        icon="close"
        iconOnly
        onClick={() => editor.removeRecipient(recipient.key)}
        size="sm"
        variant="ghost"
      />
    </li>
  );
}

function FieldToolbox({ editor }: { editor: Editor }) {
  const { activeKey, draft, tool } = editor;
  if (draft.recipients.length === 0) return null;
  return (
    <Card title="Fields">
      <div className="stack stackMd">
        <Field label="Place fields for">
          <select
            className="select"
            onChange={(event) => editor.setActiveKey(event.target.value)}
            value={activeKey ?? ""}
          >
            {draft.recipients.map((recipient, index) => (
              <option key={recipient.key} value={recipient.key}>
                {recipient.name || `Signer ${index + 1}`}
              </option>
            ))}
          </select>
        </Field>
        <fieldset className="contractTools">
          <legend className="srOnly">Field types</legend>
          {fieldTypes.map((kind) => (
            <button
              aria-pressed={tool === kind.type}
              className="contractTool"
              key={kind.type}
              onClick={(event) => {
                // Keyboard activation has no pointer to place with.
                if (event.detail === 0) editor.placeFromKeyboard(kind.type);
                else editor.setTool(tool === kind.type ? null : kind.type);
              }}
              type="button"
            >
              <Icon name={kind.icon} size={16} />
              {kind.label}
            </button>
          ))}
        </fieldset>
        <p className="contractHint">
          {tool
            ? `Click the document where the ${fieldTypeLabel(tool).toLowerCase()} field goes.`
            : "Choose a field, then click the document to place it. Drag fields to move them, or use the arrow keys."}
        </p>
      </div>
    </Card>
  );
}

function SelectedField({ editor }: { editor: Editor }) {
  const field = editor.draft.fields.find(
    ({ key }) => key === editor.selectedKey,
  );
  if (!field) return null;
  const owner = editor.draft.recipients.find(
    ({ key }) => key === field.recipientKey,
  );
  return (
    <Card
      actions={
        <Button
          icon="trash"
          onClick={() => editor.removeField(field.key)}
          size="sm"
          variant="danger"
        >
          Remove
        </Button>
      }
      title={`${fieldTypeLabel(field.type)} field`}
    >
      <div className="stack stackMd">
        <p className="contractHint">
          For {owner?.name || "a signer"} on page {field.page}.
        </p>
        {editor.pageCount > 1 && (
          <Field label="Page">
            <select
              className="select"
              onChange={(event) =>
                editor.changeField(field.key, {
                  page: Number(event.target.value),
                })
              }
              value={field.page}
            >
              {pageNumbers(editor.pageCount).map((number) => (
                <option key={number} value={number}>
                  Page {number}
                </option>
              ))}
            </select>
          </Field>
        )}
        {field.type === "text" && (
          <>
            <Field label="Label" optional>
              <input
                className="input inputSm"
                maxLength={100}
                onChange={(event) =>
                  editor.changeField(field.key, { label: event.target.value })
                }
                placeholder="Job title"
                value={field.label ?? ""}
              />
            </Field>
            <label className="check">
              <input
                checked={field.required}
                onChange={(event) =>
                  editor.changeField(field.key, {
                    required: event.target.checked,
                  })
                }
                type="checkbox"
              />
              Required
            </label>
          </>
        )}
      </div>
    </Card>
  );
}

function DraftActions({ editor }: { editor: Editor }) {
  return (
    <div className="contractEditorActions">
      <Button
        disabled={editor.busy}
        icon="trash"
        onClick={editor.remove}
        variant="ghost"
      >
        Delete
      </Button>
      <Button
        disabled={editor.busy || !editor.dirty}
        onClick={() => void editor.save()}
      >
        {editor.busy ? "Saving…" : editor.dirty ? "Save now" : "Saved"}
      </Button>
      <Button
        busy={editor.busy}
        icon="send"
        onClick={() => void editor.send()}
        variant="primary"
      >
        Send for signature
      </Button>
    </div>
  );
}

function EditorOverlay({ editor, page }: { editor: Editor; page: PageSize }) {
  const { activeKey, draft, pageSizes, tool } = editor;
  useEffect(() => {
    pageSizes.set(page.number, page);
  }, [page, pageSizes]);
  function hold(event: PointerEvent<HTMLDivElement>) {
    // Keep the browser from moving focus off the field a click places.
    if (tool && event.button === 0 && event.target === event.currentTarget)
      event.preventDefault();
  }
  // Placing on click ignores other buttons and touches that scroll.
  function place(event: MouseEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (!tool || !activeKey) {
      editor.setSelectedKey(undefined);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const box = placeNewField(
      tool,
      page.number,
      {
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height,
      },
      page,
    );
    editor.addField({
      ...box,
      key: crypto.randomUUID(),
      label: null,
      recipientKey: activeKey,
      required: true,
      type: tool,
    });
    editor.setTool(null);
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keyboard users place fields from the toolbox.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users place fields from the toolbox.
    <div
      className={cx("contractOverlayHit", tool && "contractOverlayPlacing")}
      onClick={place}
      onPointerDown={hold}
    >
      {draft.fields
        .filter((field) => field.page === page.number)
        .map((field) => (
          <DraftFieldBox editor={editor} field={field} key={field.key} />
        ))}
    </div>
  );
}

/** A placed field: select it to edit, drag it to move it, Delete to remove. */
function DraftFieldBox({
  editor,
  field,
}: {
  editor: Editor;
  field: DraftField;
}) {
  const index = editor.draft.recipients.findIndex(
    ({ key }) => key === field.recipientKey,
  );
  const owner = editor.draft.recipients[index];
  const selected = editor.selectedKey === field.key;
  const button = useRef<HTMLButtonElement>(null);
  const { justPlaced } = editor;
  // Focus a field once when it is placed, so arrow keys and Delete work.
  useEffect(() => {
    if (justPlaced.current !== field.key) return;
    justPlaced.current = null;
    button.current?.focus();
  }, [field.key, justPlaced]);
  const select = () => editor.setSelectedKey(field.key);
  function drag(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    event.preventDefault();
    // Safari doesn't focus buttons on click; keyboard removal needs focus.
    event.currentTarget.focus();
    editor.setSelectedKey(field.key);
    const overlay = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!overlay) return;
    const start = { x: event.clientX, y: event.clientY };
    const origin = { x: field.x, y: field.y };
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (moveEvent: globalThis.PointerEvent) => {
      const box = clampBox({
        ...field,
        x: origin.x + (moveEvent.clientX - start.x) / overlay.width,
        y: origin.y + (moveEvent.clientY - start.y) / overlay.height,
      });
      editor.changeField(field.key, { x: box.x, y: box.y });
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  }
  function key(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      // Keep keyboard users in the editor rather than back at the page top.
      const tools = event.currentTarget
        .closest(".contractEditor")
        ?.querySelector<HTMLElement>(".contractTool");
      editor.removeField(field.key);
      tools?.focus();
      return;
    }
    const step = event.shiftKey ? 0.05 : 0.01;
    const offset = arrowOffsets[event.key];
    if (!offset) return;
    event.preventDefault();
    const box = nudgeBox(field, offset.x * step, offset.y * step);
    editor.changeField(field.key, { x: box.x, y: box.y });
  }
  const label = `${fieldTypeLabel(field.type)} for ${owner?.name || "signer"} on page ${field.page}`;
  return (
    <button
      aria-describedby={fieldHelpId}
      aria-label={label}
      aria-pressed={selected}
      className={cx(
        "contractField",
        recipientTone(Math.max(index, 0)),
        selected && "contractFieldSelected",
      )}
      onClick={select}
      onFocus={select}
      onKeyDown={key}
      onPointerDown={drag}
      ref={button}
      style={boxStyle(field)}
      type="button"
    >
      <span className="contractFieldLabel">
        {fieldTypeLabel(field.type)}
        {owner?.name ? ` · ${initialsFor(owner.name)}` : ""}
      </span>
    </button>
  );
}

function pageNumbers(count: number) {
  return Array.from({ length: count }, (_, index) => index + 1);
}

const arrowOffsets: Record<string, { x: number; y: number }> = {
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
};

function draftFrom(contract: ContractDetail): DraftInput {
  return {
    dueDate: contract.dueDate,
    fields: contract.fields.map((field) => ({
      height: field.height,
      key: field.id,
      label: field.label,
      page: field.page,
      recipientKey: field.recipientId,
      required: field.required,
      type: field.type,
      width: field.width,
      x: field.x,
      y: field.y,
    })),
    message: contract.message,
    recipients: contract.recipients.map((recipient) => ({
      email: recipient.email,
      key: recipient.id,
      name: recipient.name,
      routingOrder: recipient.routingOrder,
    })),
    reminderIntervalDays: contract.reminderIntervalDays,
    signingOrder: contract.signingOrder,
    title: contract.title,
  };
}

async function fetchDocument(id: string) {
  const response = await fetch(contractDocumentUrl(id), {
    credentials: "include",
  });
  if (!response.ok) throw new Error("The document could not be loaded.");
  return response.arrayBuffer();
}
