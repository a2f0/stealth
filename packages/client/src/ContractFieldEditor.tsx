import { Button, Card, cx, Field, Icon } from "@tearleads/ui/react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { boxStyle, type PageSize } from "./ContractDocument";
import {
  clampBox,
  fieldTypeLabel,
  fieldTypes,
  initialsFor,
  nudgeBox,
  placeNewField,
  recipientTone,
} from "./contractFields";
import type { DraftField, DraftInput, FieldType } from "./contractsApi";

type Editor = ReturnType<typeof useContractFieldEditor>;
const fieldHelpId = "contractFieldHelp";
const letterPage: PageSize = { height: 792, number: 1, width: 612 };

export function FieldHelp() {
  return (
    <p className="srOnly" id={fieldHelpId}>
      Arrow keys move the field; hold Shift to move it further. Delete removes
      it.
    </p>
  );
}

/** Shared placement and selection for contract drafts and unassigned template roles. */
export function useContractFieldEditor(
  draft: DraftInput,
  update: (change: (draft: DraftInput) => DraftInput) => void,
  pageCount: number,
) {
  const [activeKey, setActiveKey] = useState(draft.recipients[0]?.key);
  const [tool, setTool] = useState<FieldType | null>(null);
  const [selectedKey, setSelectedKey] = useState<string>();
  const pageSizes = useRef(new Map<number, PageSize>());
  const justPlaced = useRef<string | null>(null);
  const active = draft.recipients.some(({ key }) => key === activeKey)
    ? activeKey
    : draft.recipients[0]?.key;
  const fields = fieldActions(update, setSelectedKey, justPlaced);
  return {
    ...fields,
    activeKey: active,
    draft,
    justPlaced,
    pageCount,
    pageSizes: pageSizes.current,
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

export function FieldToolbox({ editor }: { editor: Editor }) {
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

export function SelectedField({ editor }: { editor: Editor }) {
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

export function EditorOverlay({
  editor,
  page,
}: {
  editor: Editor;
  page: PageSize;
}) {
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
