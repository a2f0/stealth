export const adminUserPageSize = 25;

export function adminUserListQuery(page: number) {
  return {
    filterField: "role",
    filterOperator: "ne" as const,
    filterValue: "system",
    limit: adminUserPageSize,
    offset: page * adminUserPageSize,
    sortBy: "createdAt",
    sortDirection: "desc" as const,
  };
}
