import type { IconName } from "@tearleads/ui/react";
import type { InboundEmailLink } from "./api";
import { equipmentName, equipmentTypeIcon } from "./equipmentLabels";
import { formatMoney } from "./financeFormat";
import { equipmentPath, libraryPath } from "./workspacePaths";

/** The icon, text, and destination of an email's link chip. */
export function describeEmailLink(link: InboundEmailLink): {
  icon: IconName;
  label: string;
  path: string;
} {
  if (link.targetType === "library_folder") {
    return {
      icon: "folder",
      label: link.folder.name,
      path: libraryPath(link.targetId),
    };
  }
  if (link.targetType === "equipment") {
    const serial = link.equipment.serialNumber;
    return {
      icon: equipmentTypeIcon(link.equipment.type),
      label: serial
        ? `${equipmentName(link.equipment)} · ${serial}`
        : equipmentName(link.equipment),
      path: equipmentPath(link.targetId),
    };
  }
  const { transaction } = link;
  return {
    icon: "finance",
    label: `${transaction.merchantName ?? transaction.name} · ${formatMoney(-transaction.amount, transaction.currencyCode)} · ${formatTransactionDate(transaction.date)}`,
    path: "/finance",
  };
}

export function formatTransactionDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}
