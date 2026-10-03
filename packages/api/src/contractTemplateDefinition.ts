import { type Draft, draftInput, validEmail } from "./contractDraft";

interface Role {
  key: string;
  label: string;
  routingOrder: number;
}

export interface TemplateDefinition {
  fields: Array<
    Omit<Draft["fields"][number], "recipientKey"> & { roleKey: string }
  >;
  message: string;
  reminderIntervalDays: number | null;
  roles: Role[];
  signingOrder: Draft["signingOrder"];
}

export function templateInput(body: unknown, pageCount: number) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return "The template is invalid.";
  const name = Reflect.get(body, "name");
  const description = Reflect.get(body, "description");
  const definition = Reflect.get(body, "definition");
  if (typeof description !== "string" || description.length > 2000)
    return "Keep the description to 2,000 characters.";
  if (!definition || typeof definition !== "object")
    return "The template definition is invalid.";
  const roles = Reflect.get(definition, "roles");
  const fields = Reflect.get(definition, "fields");
  if (!Array.isArray(roles) || !roles.length)
    return "Add at least one signer role.";
  if (!Array.isArray(fields)) return "The template fields are invalid.";
  const recipients = roles.map((role: unknown) => {
    if (!role || typeof role !== "object") return null;
    return {
      email: "",
      key: Reflect.get(role, "key"),
      name: Reflect.get(role, "label"),
      routingOrder: Reflect.get(role, "routingOrder"),
    };
  });
  if (
    recipients.some(
      (role) => !role || typeof role.name !== "string" || !role.name.trim(),
    )
  )
    return "Give every signer role a label.";
  const draft = draftInput(
    {
      dueDate: null,
      fields: fields.map((field: unknown) =>
        field && typeof field === "object"
          ? { ...field, recipientKey: Reflect.get(field, "roleKey") }
          : null,
      ),
      message: Reflect.get(definition, "message"),
      recipients,
      reminderIntervalDays: Reflect.get(definition, "reminderIntervalDays"),
      signingOrder: Reflect.get(definition, "signingOrder"),
      title: name,
    },
    pageCount,
  );
  if (typeof draft === "string") return draft;
  const labels = draft.recipients.map(({ name }) => name.toLowerCase());
  if (new Set(labels).size !== labels.length)
    return "Give each signer role a different label.";
  // Persist only role labels and validated boxes, never recipient identities.
  const normalized: TemplateDefinition = {
    fields: draft.fields.map(({ recipientKey, ...field }) => ({
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
  return {
    definition: normalized,
    description: description.trim(),
    name: draft.title,
  };
}

/** Maps each role once; every field follows its role into the new draft. */
export function mappedDraft(
  body: unknown,
  name: string,
  definition: TemplateDefinition,
  pageCount: number,
) {
  if (!body || typeof body !== "object")
    return "Map every signer role to a person.";
  const recipients = Reflect.get(body, "recipients");
  if (
    !Array.isArray(recipients) ||
    recipients.length !== definition.roles.length
  )
    return "Map every signer role to a person.";
  const keys = new Set<string>();
  const mapped = [];
  for (const recipient of recipients as unknown[]) {
    if (!recipient || typeof recipient !== "object")
      return "A signer is invalid.";
    const key = Reflect.get(recipient, "roleKey");
    const role = definition.roles.find((role) => role.key === key);
    if (!role || keys.has(role.key))
      return "Map every signer role exactly once.";
    keys.add(role.key);
    const personName = Reflect.get(recipient, "name");
    const email = Reflect.get(recipient, "email");
    if (typeof personName !== "string" || !personName.trim())
      return `Choose a name for ${role.label}.`;
    if (typeof email !== "string" || !validEmail(email.trim()))
      return `Choose a valid email address for ${role.label}.`;
    mapped.push({
      email,
      key: role.key,
      name: personName,
      routingOrder: role.routingOrder,
    });
  }
  return draftInput(
    {
      dueDate: Reflect.get(body, "dueDate"),
      fields: definition.fields.map(({ roleKey, ...field }) => ({
        ...field,
        recipientKey: roleKey,
      })),
      message: definition.message,
      recipients: mapped,
      reminderIntervalDays: definition.reminderIntervalDays,
      signingOrder: definition.signingOrder,
      title: Reflect.get(body, "title") ?? name,
    },
    pageCount,
  );
}
