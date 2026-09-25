/** "everyone", "unassigned", or a member's user id. */
export type AssigneeFilter = string;

/**
 * The equipment matching a type ("all" or a type) and an assignee filter
 * ("everyone", "unassigned", or a member's user id).
 */
export function filterEquipment<
  Item extends { assignee: { id: string } | null; type: string },
>(equipment: Item[], type: string, assignee: AssigneeFilter) {
  return equipment.filter(
    (item) =>
      (type === "all" || item.type === type) &&
      (assignee === "everyone" ||
        (assignee === "unassigned"
          ? !item.assignee
          : item.assignee?.id === assignee)),
  );
}
