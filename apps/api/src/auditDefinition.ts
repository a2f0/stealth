export type AuditResponseType = "check" | "text";

export interface AuditTemplateItem {
  id: string;
  prompt: string;
  required: boolean;
  responseType: AuditResponseType;
}

export interface AuditTemplateSection {
  id: string;
  items: AuditTemplateItem[];
  title: string;
}

export interface AuditDefinition {
  sections: AuditTemplateSection[];
  version: 1;
}

interface UnknownRecord {
  assignedTo?: unknown;
  definition?: unknown;
  description?: unknown;
  id?: unknown;
  itemId?: unknown;
  items?: unknown;
  name?: unknown;
  priority?: unknown;
  prompt?: unknown;
  required?: unknown;
  responses?: unknown;
  responseType?: unknown;
  sections?: unknown;
  status?: unknown;
  title?: unknown;
  version?: unknown;
  [key: string]: unknown;
}

const maxSections = 50;
const maxItemsPerSection = 100;

export function parseAuditDefinition(value: unknown): AuditDefinition | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.sections)
  ) {
    return null;
  }
  if (value.sections.length === 0 || value.sections.length > maxSections) {
    return null;
  }
  const sections = value.sections.map(parseSection);
  return sections.every((section) => section !== null)
    ? { sections: sections as AuditTemplateSection[], version: 1 }
    : null;
}

function parseSection(value: unknown): AuditTemplateSection | null {
  if (!isRecord(value) || !validText(value.id, 100)) return null;
  if (!validText(value.title, 200) || !Array.isArray(value.items)) {
    return null;
  }
  if (value.items.length === 0 || value.items.length > maxItemsPerSection) {
    return null;
  }
  const items = value.items.map(parseItem);
  return items.every((item) => item !== null)
    ? {
        id: value.id,
        items: items as AuditTemplateItem[],
        title: value.title.trim(),
      }
    : null;
}

function parseItem(value: unknown): AuditTemplateItem | null {
  if (!isRecord(value) || !validText(value.id, 100)) return null;
  if (!validText(value.prompt, 500) || typeof value.required !== "boolean") {
    return null;
  }
  if (value.responseType !== "check" && value.responseType !== "text") {
    return null;
  }
  return {
    id: value.id,
    prompt: value.prompt.trim(),
    required: value.required,
    responseType: value.responseType,
  };
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= maxLength
  );
}
