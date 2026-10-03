import { Banner, Button, Card, Field } from "@tearleads/ui/react";
import { useEffect, useRef, useState } from "react";
import { boxStyle, ContractPages } from "./ContractDocument";
import { fieldTypeLabel, localDate, recipientTone } from "./contractFields";
import {
  type ContractTemplate,
  createContractFromTemplate,
  loadTemplateDocument,
} from "./contractTemplatesApi";

export function ContractTemplateMapping({
  template,
  onCreated,
  onCancel,
  onBusyChange,
}: {
  template: ContractTemplate;
  onCreated: (id: string) => void;
  onCancel: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const mapping = useRoleMapping(template, onCreated, onBusyChange);
  return (
    <div className="contractEditor">
      <aside className="contractEditorPanel">
        {mapping.error && <Banner tone="danger">{mapping.error}</Banner>}
        <Card title={`Use version ${template.version}`}>
          <MappingForm
            mapping={mapping}
            onCancel={onCancel}
            template={template}
          />
        </Card>
      </aside>
      <div className="contractEditorDocument">
        <ContractPages
          load={() => loadTemplateDocument(template.id, template.version)}
          renderOverlay={(page) =>
            template.definition.fields
              .filter((field) => field.page === page.number)
              .map((field) => {
                const roleIndex = template.definition.roles.findIndex(
                  (role) => role.key === field.roleKey,
                );
                return (
                  <span
                    className={`contractField contractFieldStatic ${recipientTone(roleIndex)}`}
                    key={fieldKey(field)}
                    style={boxStyle(field)}
                  >
                    <span className="contractFieldLabel">
                      {fieldTypeLabel(field.type)} ·{" "}
                      {template.definition.roles[roleIndex]?.label}
                    </span>
                  </span>
                );
              })
          }
        />
      </div>
    </div>
  );
}

type Mapping = ReturnType<typeof useRoleMapping>;
function useRoleMapping(
  template: ContractTemplate,
  onCreated: (id: string) => void,
  onBusyChange: (busy: boolean) => void,
) {
  const [title, setTitle] = useState(template.name);
  const [dueDate, setDueDate] = useState("");
  const [recipients, setRecipients] = useState(() =>
    template.definition.roles.map((role) => ({
      email: "",
      name: "",
      roleKey: role.key,
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const creating = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      onBusyChange(false);
    };
  }, [onBusyChange]);
  async function create() {
    if (creating.current) return;
    creating.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const id = await createContractFromTemplate(template.id, {
        dueDate: dueDate || null,
        recipients,
        title,
        version: template.version,
      });
      if (mounted.current) onCreated(id);
    } catch (cause) {
      if (!mounted.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not create the contract.",
      );
      creating.current = false;
      setBusy(false);
    }
  }
  return {
    busy,
    create,
    dueDate,
    error,
    recipients,
    setDueDate,
    setRecipients,
    setTitle,
    title,
  };
}

function MappingForm({
  mapping,
  onCancel,
  template,
}: {
  mapping: Mapping;
  onCancel: () => void;
  template: ContractTemplate;
}) {
  const { busy, create, dueDate, setDueDate, setTitle, title } = mapping;
  return (
    <form
      className="stack stackMd"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <p className="contractHint">
        Map each role to a person. Their fields are already placed. You can
        review the draft before sending.
      </p>
      <Field label="Contract title">
        <input
          className="input"
          disabled={busy}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          required
          value={title}
        />
      </Field>
      <Field label="Due date" optional>
        <input
          className="input"
          disabled={busy}
          min={localDate()}
          onChange={(event) => setDueDate(event.target.value)}
          type="date"
          value={dueDate}
        />
      </Field>
      {template.definition.roles.map((role) => (
        <MappingRole mapping={mapping} key={role.key} role={role} />
      ))}
      <Button busy={busy} type="submit" variant="primary">
        Create contract
      </Button>
      <Button disabled={busy} onClick={onCancel} type="button" variant="ghost">
        Back to template
      </Button>
    </form>
  );
}

const fieldKeys = new WeakMap<object, string>();
function fieldKey(field: object) {
  let key = fieldKeys.get(field);
  if (!key) {
    key = crypto.randomUUID();
    fieldKeys.set(field, key);
  }
  return key;
}

function MappingRole({
  mapping,
  role,
}: {
  mapping: Mapping;
  role: ContractTemplate["definition"]["roles"][number];
}) {
  const { busy, recipients, setRecipients } = mapping;
  const recipient = recipients.find((person) => person.roleKey === role.key);
  const change = (property: "name" | "email", value: string) =>
    setRecipients((current) =>
      current.map((person) =>
        person.roleKey === role.key ? { ...person, [property]: value } : person,
      ),
    );
  return (
    <fieldset
      className="stack stackSm contractTemplateRole"
      disabled={busy}
      key={role.key}
    >
      <legend>{role.label}</legend>
      <Field label={`${role.label} name`}>
        <input
          autoComplete="name"
          className="input"
          maxLength={120}
          onChange={(event) => change("name", event.target.value)}
          required
          value={recipient?.name ?? ""}
        />
      </Field>
      <Field label={`${role.label} email`}>
        <input
          autoComplete="email"
          className="input"
          maxLength={254}
          onChange={(event) => change("email", event.target.value)}
          required
          type="email"
          value={recipient?.email ?? ""}
        />
      </Field>
    </fieldset>
  );
}
