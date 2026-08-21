import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from "react";
import {
  type AdminOrganization,
  listAdminOrganizations,
  markAdminOrganizationForDeletion,
  restoreAdminOrganization,
} from "./api";
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

interface AdminOrganizationAction {
  organizationId: string;
  type: "delete" | "restore";
}

export function AdminUsers() {
  const [listing, setListing] = useState<UserListing>();
  const [organizations, setOrganizations] = useState<AdminOrganization[]>();
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const lifecycle = useAdminOrganizationLifecycle(setOrganizations);

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
        {lifecycle.error && (
          <div className="errorBanner">{lifecycle.error}</div>
        )}
        {lifecycle.notice && (
          <div aria-live="polite" className="successBanner pageBanner">
            {lifecycle.notice}
          </div>
        )}
        <UserSection
          busy={busy}
          hasError={Boolean(error)}
          listing={listing}
          onPageChange={setPage}
          page={page}
        />
        <OrganizationSection
          action={lifecycle.action}
          onMarkForDeletion={lifecycle.markForDeletion}
          onRestore={lifecycle.restore}
          organizations={organizations}
        />
      </section>
    </>
  );
}

function useAdminOrganizationLifecycle(
  setOrganizations: Dispatch<SetStateAction<AdminOrganization[] | undefined>>,
) {
  const [action, setAction] = useState<AdminOrganizationAction>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const markForDeletion = async (organization: AdminOrganization) => {
    const confirmation = window.prompt(
      `Type ${organization.name} to mark this organization for deletion. It will become unavailable immediately and its data can be permanently purged after 30 days.`,
    );
    if (confirmation !== organization.name) return;

    setAction({ organizationId: organization.id, type: "delete" });
    setError(undefined);
    setNotice(undefined);
    try {
      const deletion = await markAdminOrganizationForDeletion(organization.id);
      setOrganizations((current) =>
        current?.map((item) =>
          item.id === organization.id
            ? {
                ...item,
                deletedAt: deletion.deletedAt,
                deletedByEmail: deletion.deletedByEmail,
                deletedByName: deletion.deletedByName,
                deletedByUserId: deletion.deletedByUserId,
              }
            : item,
        ),
      );
      setNotice(`${organization.name} was marked for deletion.`);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setAction(undefined);
    }
  };

  const restore = async (organization: AdminOrganization) => {
    if (
      !window.confirm(
        `Undelete ${organization.name}? Existing members who do not have another default organization will regain access.`,
      )
    ) {
      return;
    }

    setAction({ organizationId: organization.id, type: "restore" });
    setError(undefined);
    setNotice(undefined);
    try {
      await restoreAdminOrganization(organization.id);
      setOrganizations((current) =>
        current?.map((item) =>
          item.id === organization.id
            ? {
                ...item,
                deletedAt: null,
                deletedByEmail: null,
                deletedByName: null,
                deletedByUserId: null,
              }
            : item,
        ),
      );
      setNotice(`${organization.name} was restored.`);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setAction(undefined);
    }
  };

  return { action, error, markForDeletion, notice, restore };
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
  action,
  onMarkForDeletion,
  onRestore,
  organizations,
}: {
  action: AdminOrganizationAction | undefined;
  onMarkForDeletion: (organization: AdminOrganization) => Promise<void>;
  onRestore: (organization: AdminOrganization) => Promise<void>;
  organizations?: AdminOrganization[] | undefined;
}) {
  return (
    <section className="adminSection">
      <div className="sectionHeading">
        <h2>Organizations</h2>
        <span>{organizations?.length ?? 0} organizations</span>
      </div>
      {organizations && organizations.length > 0 ? (
        <OrganizationTable
          action={action}
          onMarkForDeletion={onMarkForDeletion}
          onRestore={onRestore}
          organizations={organizations}
        />
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
  action,
  onMarkForDeletion,
  onRestore,
  organizations,
}: {
  action: AdminOrganizationAction | undefined;
  onMarkForDeletion: (organization: AdminOrganization) => Promise<void>;
  onRestore: (organization: AdminOrganization) => Promise<void>;
  organizations: AdminOrganization[];
}) {
  return (
    <div className="userTableWrap">
      <table className="userTable organizationTable">
        <thead>
          <tr>
            <th>Organization</th>
            <th>Owner</th>
            <th>Members</th>
            <th>Status</th>
            <th>Marked by</th>
            <th>Created</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {organizations.map((organization) => (
            <OrganizationTableRow
              action={action}
              key={organization.id}
              onMarkForDeletion={onMarkForDeletion}
              onRestore={onRestore}
              organization={organization}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OrganizationTableRow({
  action,
  onMarkForDeletion,
  onRestore,
  organization,
}: {
  action: AdminOrganizationAction | undefined;
  onMarkForDeletion: (organization: AdminOrganization) => Promise<void>;
  onRestore: (organization: AdminOrganization) => Promise<void>;
  organization: AdminOrganization;
}) {
  return (
    <tr>
      <td>
        <strong>{organization.name}</strong>
        <span>{organization.slug}</span>
      </td>
      <td className="tableIdentity">
        <strong>{organization.ownerName ?? "—"}</strong>
        <span>{organization.ownerEmail ?? "No default owner"}</span>
      </td>
      <td>{organization.memberCount}</td>
      <td>
        <span
          className={`userStatus ${organization.deletedAt ? "banned" : "verified"}`}
        >
          {organization.deletedAt
            ? `Pending deletion · ${formatDate(organization.deletedAt)}`
            : "Active"}
        </span>
      </td>
      <td className="tableIdentity">
        {organization.deletedAt ? (
          <>
            <strong>{organization.deletedByName ?? "Unknown"}</strong>
            <span>
              {organization.deletedByEmail ??
                organization.deletedByUserId ??
                "Not recorded"}
            </span>
          </>
        ) : (
          "—"
        )}
      </td>
      <td>{formatDate(organization.createdAt)}</td>
      <td>
        <OrganizationActionButton
          action={action}
          onMarkForDeletion={onMarkForDeletion}
          onRestore={onRestore}
          organization={organization}
        />
      </td>
    </tr>
  );
}

function OrganizationActionButton({
  action,
  onMarkForDeletion,
  onRestore,
  organization,
}: {
  action: AdminOrganizationAction | undefined;
  onMarkForDeletion: (organization: AdminOrganization) => Promise<void>;
  onRestore: (organization: AdminOrganization) => Promise<void>;
  organization: AdminOrganization;
}) {
  if (organization.deletedAt) {
    const restoring =
      action?.organizationId === organization.id && action.type === "restore";
    return (
      <button
        className="primaryButton tableActionButton"
        disabled={action !== undefined}
        onClick={() => void onRestore(organization)}
        type="button"
      >
        {restoring ? "Restoring…" : "Undelete"}
      </button>
    );
  }
  const deleting =
    action?.organizationId === organization.id && action.type === "delete";
  return (
    <button
      className="dangerButton tableActionButton"
      disabled={action !== undefined}
      onClick={() => void onMarkForDeletion(organization)}
      type="button"
    >
      {deleting ? "Marking…" : "Mark for deletion"}
    </button>
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
