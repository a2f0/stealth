export const adminUserPageSize = 25;

export function adminUserListQuery(page: number) {
  return {
    filterField: "id",
    filterOperator: "ne" as const,
    filterValue: "system:audit-library",
    limit: adminUserPageSize,
    offset: page * adminUserPageSize,
    sortBy: "createdAt",
    sortDirection: "desc" as const,
  };
}
