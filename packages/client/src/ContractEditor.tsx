import { Banner, Button, Card, cx, Field } from "@tearleads/ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchApi } from "./apiVersion";
import { ContractPages } from "./ContractDocument";
import {
  EditorOverlay,
  FieldHelp,
  FieldToolbox,
  SelectedField,
  useContractFieldEditor,
} from "./ContractFieldEditor";
import {
  confirmContractDeletion,
  localDate,
  recipientTone,
  reminderOptions,
} from "./contractFields";
import {
  type ContractDetail,
  contractDocumentUrl,
  type DraftInput,
  type DraftRecipient,
  deleteContract,
  saveContractDraft,
  sendContract,
} from "./contractsApi";

type Editor = ReturnType<typeof useDraftEditor>;

/** How long after the last edit a draft saves itself. */
const autosaveDelayMs = 1200;

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
      <FieldHelp />
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
  // Counts edits, so a save marks the draft clean only if nothing changed
  // while it was in flight.
  const revision = useRef(0);
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
  const fields = useContractFieldEditor(
    draft,
    update,
    contract.document.pageCount,
  );
  return {
    ...saving,
    ...fields,
    ...recipientActions(draft, update, fields.setActiveKey),
    dirty,
  };
}

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
    remove: async () => {
      if (!(await confirmContractDeletion(contract.title))) return;
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
  const response = await fetchApi(contractDocumentUrl(id), {
    credentials: "include",
  });
  if (!response.ok) throw new Error("The document could not be loaded.");
  return response.arrayBuffer();
}
