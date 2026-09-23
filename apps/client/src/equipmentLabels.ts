import type { IconName } from "@tearleads/ui/react";
import { formatLabel } from "./labels";

const typeLabels: Record<string, { icon: IconName; label: string }> = {
  cell_phone: { icon: "cellPhone", label: "Cell phone" },
  computer: { icon: "computer", label: "Computer" },
  monitor: { icon: "monitor", label: "Monitor" },
};

/** Display name for an equipment type, including types added later. */
export function equipmentTypeLabel(type: string) {
  return typeLabels[type]?.label ?? formatLabel(type);
}

export function equipmentTypeIcon(type: string): IconName {
  return typeLabels[type]?.icon ?? "equipment";
}

/** "Apple MacBook Pro", the name equipment is known by in lists and links. */
export function equipmentName(item: { make: string; model: string }) {
  return `${item.make} ${item.model}`.trim();
}
