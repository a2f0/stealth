import { useCallback, useEffect, useState } from "react";
import { authClient } from "./authClient";
import { WorkspaceShell, type WorkspaceUser } from "./WorkspaceShell";

const pageSize = 25;

interface AdminUsersProps {
  onSignOut: () => Promise<void>;
  user: WorkspaceUser;
}

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

export function AdminUsers({ onSignOut, user }: AdminUsersProps) {
  const [listing, setListing] = useState<UserListing>();
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();

  const loadUsers = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    setListing(undefined);
    try {
      const result = await authClient.admin.listUsers({
        query: {
          limit: pageSize,
          offset: page * pageSize,
          sortBy: "createdAt",
          sortDirection: "desc",
        },
      });
      if (result.error) {
        setError(result.error.message ?? "Could not load users.");
      } else {
        setListing(result.data);
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
    <WorkspaceShell activePage="admin" onSignOut={onSignOut} user={user}>
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
        <div className="sectionHeading">
          <h2>All users</h2>
          <span>{listing?.total ?? 0} accounts</span>
        </div>
        {listing && listing.users.length > 0 ? (
          <>
            <UserTable users={listing.users} />
            <Pagination
              onPageChange={setPage}
              page={page}
              total={listing.total}
            />
          </>
        ) : !error ? (
          <AdminEmptyState busy={busy} />
        ) : null}
      </section>
    </WorkspaceShell>
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

function formatDate(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(new Date(value));
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load users.";
}
