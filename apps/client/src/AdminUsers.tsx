import { useCallback, useEffect, useState } from "react";
import { type AdminOrganization, listAdminOrganizations } from "./api";
import { authClient } from "./authClient";

const pageSize = 25;

interface ListedUser {
  banned?: boolean | null | undefined;
  createdAt: Date;
  email: string;
  emailVerified: boolean;
  id: string;
  name: string;
  role?: string | null | undefined;
}

interface UserListing {
  total: number;
  users: ListedUser[];
}

export function AdminUsers() {
  const [listing, setListing] = useState<UserListing>();
  const [organizations, setOrganizations] = useState<AdminOrganization[]>();
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();

  const loadUsers = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    setListing(undefined);
    setOrganizations(undefined);
    try {
      const [result, nextOrganizations] = await Promise.all([
        authClient.admin.listUsers({
          query: {
            limit: pageSize,
            offset: page * pageSize,
            sortBy: "createdAt",
            sortDirection: "desc",
          },
        }),
        listAdminOrganizations(),
      ]);
      if (result.error) {
        setError(result.error.message ?? "Could not load users.");
      } else {
        setListing(result.data);
        setOrganizations(nextOrganizations);
      }
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }, [page]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">Administration</p>
          <h1>Users</h1>
        </div>
        <button
          className="primaryButton"
          disabled={busy}
          onClick={() => void loadUsers()}
          type="button"
        >
          {busy ? "Loading…" : "Refresh"}
        </button>
      </header>

      <section className="content">
        {error && <div className="errorBanner">{error}</div>}
        <UserSection
          busy={busy}
          hasError={Boolean(error)}
          listing={listing}
          onPageChange={setPage}
          page={page}
        />
        <OrganizationSection organizations={organizations} />
      </section>
    </>
  );
}

function UserSection({
  busy,
  hasError,
  listing,
  onPageChange,
  page,
}: {
  busy: boolean;
  hasError: boolean;
  listing?: UserListing | undefined;
  onPageChange: (page: number) => void;
  page: number;
}) {
  return (
    <section>
      <div className="sectionHeading">
        <h2>All users</h2>
        <span>{listing?.total ?? 0} accounts</span>
      </div>
      {listing && listing.users.length > 0 ? (
        <>
          <UserTable users={listing.users} />
          <Pagination
            onPageChange={onPageChange}
            page={page}
            total={listing.total}
          />
        </>
      ) : !hasError ? (
        <AdminEmptyState busy={busy} />
      ) : null}
    </section>
  );
}

function OrganizationSection({
  organizations,
}: {
  organizations?: AdminOrganization[] | undefined;
}) {
  return (
    <section className="adminSection">
      <div className="sectionHeading">
        <h2>Organizations</h2>
        <span>{organizations?.length ?? 0} organizations</span>
      </div>
      {organizations && organizations.length > 0 ? (
        <OrganizationTable organizations={organizations} />
      ) : organizations ? (
        <div className="emptyState compactEmptyState">
          <div className="emptyGlyph">◇</div>
          <h3>No organizations found.</h3>
        </div>
      ) : null}
    </section>
  );
}

function OrganizationTable({
  organizations,
}: {
  organizations: AdminOrganization[];
}) {
  return (
    <div className="userTableWrap">
      <table className="userTable">
        <thead>
          <tr>
            <th>Organization</th>
            <th>Owner</th>
            <th>Members</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {organizations.map((organization) => (
            <tr key={organization.id}>
              <td>
                <strong>{organization.name}</strong>
                <span>{organization.slug}</span>
              </td>
              <td className="tableIdentity">
                <strong>{organization.ownerName ?? "—"}</strong>
                <span>{organization.ownerEmail ?? "No default owner"}</span>
              </td>
              <td>{organization.memberCount}</td>
              <td>{formatDate(organization.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UserTable({ users }: { users: ListedUser[] }) {
  return (
    <div className="userTableWrap">
      <table className="userTable">
        <thead>
          <tr>
            <th>User</th>
            <th>Status</th>
            <th>Role</th>
            <th>Joined</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td>
                <strong>{user.name}</strong>
                <span>{user.email}</span>
              </td>
              <td>
                <span className={`userStatus ${statusFor(user).className}`}>
                  {statusFor(user).label}
                </span>
              </td>
              <td>
                <span className="roleBadge">{user.role ?? "user"}</span>
              </td>
              <td>{formatDate(user.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Pagination({
  onPageChange,
  page,
  total,
}: {
  onPageChange: (page: number) => void;
  page: number;
  total: number;
}) {
  const start = page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, total);
  return (
    <div className="pagination">
      <span>
        {start}–{end} of {total}
      </span>
      <div>
        <button
          disabled={page === 0}
          onClick={() => onPageChange(page - 1)}
          type="button"
        >
          Previous
        </button>
        <button
          disabled={end >= total}
          onClick={() => onPageChange(page + 1)}
          type="button"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function AdminEmptyState({ busy }: { busy: boolean }) {
  return (
    <div className="emptyState compactEmptyState">
      <div className="emptyGlyph">◎</div>
      <h3>{busy ? "Loading users…" : "No users found."}</h3>
    </div>
  );
}

function statusFor(user: ListedUser) {
  if (user.banned) return { className: "banned", label: "Banned" };
  if (user.emailVerified) return { className: "verified", label: "Verified" };
  return { className: "pending", label: "Unverified" };
}

function formatDate(value: Date | number | string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(new Date(value));
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load users.";
}
