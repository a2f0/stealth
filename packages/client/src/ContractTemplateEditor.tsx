import { Banner, Button, Card, Field } from "@tearleads/ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ContractPages } from "./ContractDocument";
import {
  EditorOverlay,
  FieldHelp,
  FieldToolbox,
  SelectedField,
  useContractFieldEditor,
} from "./ContractFieldEditor";
import { reminderOptions } from "./contractFields";
import type { DraftInput } from "./contractsApi";
import {
  type ContractTemplate,
  loadTemplateDocument,
  saveTemplateVersion,
  type TemplateDefinition,
} from "./contractTemplatesApi";
import { useUnsavedChanges } from "./navigationGuard";

export function ContractTemplateEditor({
  template,
  onSaved,
  onDirtyChange,
  onBusyChange,
  disabled = false,
}: {
  template: ContractTemplate;
  onSaved: (template: ContractTemplate) => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const editor = useTemplateEditor(
    template,
    onSaved,
    onDirtyChange,
    onBusyChange,
    disabled,
  );
  return (
    <fieldset
      className="contractTemplateControls"
      disabled={editor.busy || disabled}
    >
      <legend className="srOnly">Template editor</legend>
      <div className="contractEditor">
        <FieldHelp />
        <aside className="contractEditorPanel">
          {editor.error && <Banner tone="danger">{editor.error}</Banner>}
          <TemplateDetails editor={editor} />
          <TemplateRoles editor={editor} />
          <FieldToolbox editor={editor} />
          <SelectedField editor={editor} />
          <Button
            busy={editor.busy}
            disabled={!editor.dirty}
            onClick={() => void editor.save()}
            variant="primary"
          >
            Save version {template.currentVersion + 1}
          </Button>
          <p className="contractHint">
            Saving creates a new version. Version {template.version} stays
            available.
          </p>
        </aside>
        <div className="contractEditorDocument">
          <ContractPages
            load={() => loadTemplateDocument(template.id, template.version)}
            renderOverlay={(page) => (
              <EditorOverlay editor={editor} page={page} />
            )}
          />
        </div>
      </div>
    </fieldset>
  );
}

type Editor = ReturnType<typeof useTemplateEditor>;

function useTemplateEditor(
  template: ContractTemplate,
  onSaved: (template: ContractTemplate) => void,
  onDirtyChange: (dirty: boolean) => void,
  onBusyChange: (busy: boolean) => void,
  disabled: boolean,
) {
  const [draft, setDraft] = useState(() => draftFrom(template));
  const [description, setDescription] = useState(template.description);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const saving = useRef(false);
  const update = useCallback((change: (draft: DraftInput) => DraftInput) => {
    if (saving.current) return;
    setDraft(change);
    setDirty(true);
  }, []);
  const editor = useContractFieldEditor(
    draft,
    update,
    template.document.pageCount,
  );
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  useUnsavedChanges(dirty && !disabled);

  async function save() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const definition = definitionFrom(draft);
      const saved = await saveTemplateVersion(template, {
        definition,
        description,
        name: draft.title,
      });
      onDirtyChange(false);
      onSaved(saved);
      setDirty(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save the template.",
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  function removeRole(key: string) {
    const count = draft.fields.filter(
      (field) => field.recipientKey === key,
    ).length;
    if (count && !window.confirm(`Remove this role and its ${count} fields?`))
      return;
    update((current) => ({
      ...current,
      recipients: current.recipients.filter((role) => role.key !== key),
      fields: current.fields.filter((field) => field.recipientKey !== key),
    }));
  }

  return {
    ...editor,
    busy,
    description,
    dirty,
    error,
    removeRole,
    save,
    setDescription: (value: string) => {
      setDescription(value);
      setDirty(true);
    },
  };
}

function definitionFrom(draft: DraftInput): TemplateDefinition {
  return {
    fields: draft.fields.map(({ key: _key, recipientKey, ...field }) => ({
      ...field,
      roleKey: recipientKey,
    })),
    message: draft.message,
    reminderIntervalDays: draft.reminderIntervalDays,
    roles: draft.recipients.map(({ key, name, routingOrder }) => ({
      key,
      label: name,
      routingOrder,
    })),
    signingOrder: draft.signingOrder,
  };
}

function TemplateDetails({ editor }: { editor: Editor }) {
  const { draft, update, description, setDescription } = editor;
  return (
    <Card title="Template details">
      <div className="stack stackMd">
        <Field label="Template name">
          <input
            className="input"
            maxLength={200}
            onChange={(event) =>
              update((current) => ({
                ...current,
                title: event.target.value,
              }))
            }
            value={draft.title}
          />
        </Field>
        <Field label="Description" optional>
          <textarea
            className="textarea"
            maxLength={2000}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
            rows={2}
            value={description}
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
            onChange={(event) =>
              update((current) => ({
                ...current,
                message: event.target.value,
              }))
            }
            rows={3}
            value={draft.message}
          />
        </Field>
        <Field label="Reminders">
          <select
            className="select"
            onChange={(event) =>
              update((current) => ({
                ...current,
                reminderIntervalDays: event.target.value
                  ? Number(event.target.value)
                  : null,
              }))
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
    </Card>
  );
}

function TemplateRoles({ editor }: { editor: Editor }) {
  const { draft, update } = editor;
  return (
    <Card
      actions={
        <Button
          disabled={draft.recipients.length >= 20}
          icon="add"
          onClick={() =>
            update((current) => ({
              ...current,
              recipients: [
                ...current.recipients,
                {
                  email: "",
                  key: crypto.randomUUID(),
                  name: `Role ${current.recipients.length + 1}`,
                  routingOrder: Math.min(
                    20,
                    Math.max(
                      0,
                      ...current.recipients.map((role) => role.routingOrder),
                    ) + 1,
                  ),
                },
              ],
            }))
          }
          size="sm"
          variant="ghost"
        >
          Add role
        </Button>
      }
      title="Signer roles"
    >
      <div className="stack stackMd">
        <p className="contractHint">
          Use labels such as Employee or Company. People are assigned when you
          create a contract.
        </p>
        <Field label="Signing order">
          <select
            className="select"
            onChange={(event) =>
              update((current) => ({
                ...current,
                signingOrder: event.target.value as DraftInput["signingOrder"],
              }))
            }
            value={draft.signingOrder}
          >
            <option value="parallel">Any order</option>
            <option value="sequential">One after another</option>
          </select>
        </Field>
        {draft.recipients.map((role, index) => (
          <TemplateRoleRow
            editor={editor}
            index={index}
            key={role.key}
            role={role}
          />
        ))}
      </div>
    </Card>
  );
}

function TemplateRoleRow({
  editor,
  index,
  role,
}: {
  editor: Editor;
  index: number;
  role: DraftInput["recipients"][number];
}) {
  const { draft, update, removeRole } = editor;
  return (
    <div className="stack stackSm" key={role.key}>
      <Field label={`Role ${index + 1}`}>
        <input
          className="input"
          maxLength={120}
          onChange={(event) =>
            update((current) => ({
              ...current,
              recipients: current.recipients.map((item) =>
                item.key === role.key
                  ? { ...item, name: event.target.value }
                  : item,
              ),
            }))
          }
          value={role.name}
        />
      </Field>
      {draft.signingOrder === "sequential" && (
        <Field label={`${role.name || "Role"} signs in position`}>
          <input
            className="input inputSm"
            max={20}
            min={1}
            onChange={(event) =>
              update((current) => ({
                ...current,
                recipients: current.recipients.map((item) =>
                  item.key === role.key
                    ? {
                        ...item,
                        routingOrder: Number(event.target.value) || 1,
                      }
                    : item,
                ),
              }))
            }
            type="number"
            value={role.routingOrder}
          />
        </Field>
      )}
      <Button onClick={() => removeRole(role.key)} size="sm" variant="ghost">
        Remove {role.name || "role"}
      </Button>
    </div>
  );
}

function draftFrom(template: ContractTemplate): DraftInput {
  return {
    dueDate: null,
    fields: template.definition.fields.map(({ roleKey, ...field }) => ({
      ...field,
      key: crypto.randomUUID(),
      recipientKey: roleKey,
    })),
    message: template.definition.message,
    recipients: template.definition.roles.map(
      ({ key, label, routingOrder }) => ({
        email: "",
        key,
        name: label,
        routingOrder,
      }),
    ),
    reminderIntervalDays: template.definition.reminderIntervalDays,
    signingOrder: template.definition.signingOrder,
    title: template.name,
  };
}
