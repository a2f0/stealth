import { Banner, Button, Card, cx, Field, Icon } from "@tearleads/ui/react";
import {
  type KeyboardEvent,
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
  type FieldType,
  saveContractDraft,
  sendContract,
} from "./contractsApi";

type Editor = ReturnType<typeof useDraftEditor>;

/** Prepares a draft: details, signers, and fields placed on the document. */
export function ContractEditor({
  contract,
  onChanged,
}: {
  contract: ContractDetail;
  onChanged: (contract: ContractDetail) => void;
}) {
  const editor = useDraftEditor(contract, onChanged);
  return (
    <div className="contractEditor">
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
) {
  const [draft, setDraft] = useState(() => draftFrom(contract));
  const [dirty, setDirty] = useState(false);
  const [activeKey, setActiveKey] = useState(draft.recipients[0]?.key);
  const [tool, setTool] = useState<FieldType | null>(null);
  const [selectedKey, setSelectedKey] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const update = useCallback((change: (draft: DraftInput) => DraftInput) => {
    setDraft(change);
    setDirty(true);
    setNotice(undefined);
  }, []);

  async function persist(send: boolean) {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      let saved = dirty
        ? await saveContractDraft(contract.id, draft)
        : contract;
      if (dirty) {
        setDraft(draftFrom(saved));
        setDirty(false);
        setActiveKey(saved.recipients[0]?.id);
        setSelectedKey(undefined);
      }
      if (send) saved = await sendContract(contract.id);
      onChanged(saved);
      if (!send) setNotice("Draft saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return {
    activeKey: draft.recipients.some(({ key }) => key === activeKey)
      ? activeKey
      : draft.recipients[0]?.key,
    busy,
    dirty,
    draft,
    error,
    notice,
    ...recipientActions(draft, update, setActiveKey),
    ...fieldActions(update, setSelectedKey),
    save: () => persist(false),
    selectedKey,
    send: () => persist(true),
    setActiveKey,
    setSelectedKey,
    setTool,
    tool,
    update,
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
) {
  return {
    addField: (field: DraftField) => {
      update((current) => ({ ...current, fields: [...current.fields, field] }));
      setSelectedKey(field.key);
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
              onClick={() =>
                editor.setTool(tool === kind.type ? null : kind.type)
              }
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
            : "Choose a field, then click the document to place it. Drag fields to move them."}
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
        busy={editor.busy && editor.dirty}
        disabled={editor.busy || !editor.dirty}
        onClick={() => void editor.save()}
      >
        {editor.dirty ? "Save draft" : "Saved"}
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
  const { activeKey, draft, tool } = editor;
  function place(event: PointerEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    // Keep the browser from moving focus off the field this click places.
    event.preventDefault();
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
    <div
      className={cx("contractOverlayHit", tool && "contractOverlayPlacing")}
      onPointerDown={place}
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
  // A field mounts selected only when just placed: focus it so Delete works.
  const placed = useRef(selected);
  useEffect(() => {
    if (placed.current) button.current?.focus();
  }, []);
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
      editor.removeField(field.key);
    }
  }
  const label = `${fieldTypeLabel(field.type)} for ${owner?.name || "signer"}`;
  return (
    <button
      aria-label={label}
      aria-pressed={selected}
      className={cx(
        "contractField",
        recipientTone(Math.max(index, 0)),
        selected && "contractFieldSelected",
      )}
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
