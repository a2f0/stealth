export type AuditTemplateView = "grid" | "list";

export const defaultAuditTemplateView: AuditTemplateView = "grid";

const auditTemplateViewStorageKey = "tearleads.audit-template-view";

interface StorageReader {
  getItem(key: string): string | null;
}

interface StorageWriter {
  setItem(key: string, value: string): void;
}

export function readAuditTemplateView(
  storage?: StorageReader,
): AuditTemplateView {
  try {
    const availableStorage = storage ?? window.localStorage;
    const storedView = availableStorage.getItem(auditTemplateViewStorageKey);
    return storedView === "list" ? "list" : defaultAuditTemplateView;
  } catch {
    return defaultAuditTemplateView;
  }
}

export function storeAuditTemplateView(
  view: AuditTemplateView,
  storage?: StorageWriter,
) {
  try {
    const availableStorage = storage ?? window.localStorage;
    availableStorage.setItem(auditTemplateViewStorageKey, view);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}
