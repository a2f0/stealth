import {
  Avatar,
  Badge,
  type BadgeTone,
  Banner,
  Button,
  EmptyState,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
} from "@tearleads/ui/react";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from "react";
import { adminUserListQuery, adminUserPageSize } from "./adminUserList";
import {
  type AdminOrganization,
  listAdminOrganizations,
  markAdminOrganizationForDeletion,
  restoreAdminOrganization,
} from "./api";
import { authClient } from "./authClient";
import { countLabel } from "./labels";

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

interface OrganizationActions {
  action: AdminOrganizationAction | undefined;
  onMarkForDeletion: (organization: AdminOrganization) => Promise<void>;
  onRestore: (organization: AdminOrganization) => Promise<void>;
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
          query: adminUserListQuery(page),
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
    <Page>
      <PageHeader
        actions={
          <Button busy={busy} icon="refresh" onClick={() => void loadUsers()}>
            {busy ? "Loading…" : "Refresh"}
          </Button>
        }
        description="Every account and organization on the platform."
        eyebrow="Administration"
        title="Users"
      />
      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}
        {lifecycle.error && <Banner tone="danger">{lifecycle.error}</Banner>}
        {lifecycle.notice && <Banner tone="success">{lifecycle.notice}</Banner>}
        <UserSection
          busy={busy}
          hasError={Boolean(error)}
          listing={listing}
          onPageChange={setPage}
          page={page}
        />
        <OrganizationSection
          action={lifecycle.action}
          busy={busy}
          onMarkForDeletion={lifecycle.markForDeletion}
          onRestore={lifecycle.restore}
          organizations={organizations}
        />
      </PageBody>
    </Page>
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
        `Restore ${organization.name}? Existing members who do not have another default organization will regain access.`,
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
    <PageSection
      actions={
        <span className="sectionCount">
          {countLabel(listing?.total ?? 0, "account", "accounts")}
        </span>
      }
      title="All users"
    >
      {listing && listing.users.length > 0 ? (
        <div className="stack stackMd">
          <UserTable users={listing.users} />
          <Pagination
            onPageChange={onPageChange}
            page={page}
            total={listing.total}
          />
        </div>
      ) : hasError ? null : busy ? (
        <LoadingState label="Loading users…" />
      ) : (
        <EmptyState compact icon="organization" title="No users found." />
      )}
    </PageSection>
  );
}

function OrganizationSection({
  action,
  busy,
  onMarkForDeletion,
  onRestore,
  organizations,
}: OrganizationActions & {
  busy: boolean;
  organizations?: AdminOrganization[] | undefined;
}) {
  return (
    <PageSection
      actions={
        <span className="sectionCount">
          {countLabel(
            organizations?.length ?? 0,
            "organization",
            "organizations",
          )}
        </span>
      }
      title="Organizations"
    >
      {organizations && organizations.length > 0 ? (
        <OrganizationTable
          action={action}
          onMarkForDeletion={onMarkForDeletion}
          onRestore={onRestore}
          organizations={organizations}
        />
      ) : organizations ? (
        <EmptyState
          compact
          icon="organization"
          title="No organizations found."
        />
      ) : busy ? (
        <LoadingState label="Loading organizations…" />
      ) : null}
    </PageSection>
  );
}

function OrganizationTable({
  action,
  onMarkForDeletion,
  onRestore,
  organizations,
}: OrganizationActions & { organizations: AdminOrganization[] }) {
  return (
    <div className="tableWrap">
      <table className="table adminOrganizationTable">
        <thead>
          <tr>
            <th scope="col">Organization</th>
            <th scope="col">Owner</th>
            <th className="adminNumeric" scope="col">
              Members
            </th>
            <th scope="col">Status</th>
            <th scope="col">Marked by</th>
            <th scope="col">Created</th>
            <th scope="col">
              <span className="srOnly">Actions</span>
            </th>
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
}: OrganizationActions & { organization: AdminOrganization }) {
  return (
    <tr>
      <td>
        <div className="adminIdentityText adminOrganization">
          <span className="adminOrganizationName">{organization.name}</span>
          <span className="adminSlug mono">{organization.slug}</span>
        </div>
      </td>
      <td>
        {organization.ownerName || organization.ownerEmail ? (
          <Identity
            detail={
              organization.ownerName
                ? (organization.ownerEmail ?? undefined)
                : undefined
            }
            name={organization.ownerName || organization.ownerEmail || ""}
          />
        ) : (
          <span className="textSubtle">No default owner</span>
        )}
      </td>
      <td className="adminNumeric tabular">{organization.memberCount}</td>
      <td>
        <OrganizationStatus deletedAt={organization.deletedAt} />
      </td>
      <td>
        <DeletedBy organization={organization} />
      </td>
      <td className="adminDate tabular">
        {formatDate(organization.createdAt)}
      </td>
      <td className="adminActions">
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

function OrganizationStatus({
  deletedAt,
}: {
  deletedAt: AdminOrganization["deletedAt"];
}) {
  if (!deletedAt) {
    return (
      <Badge dot tone="success">
        Active
      </Badge>
    );
  }
  return (
    <div className="adminStatus">
      <Badge dot tone="danger">
        Pending deletion
      </Badge>
      <span className="textXs textSubtle tabular">
        Since {formatDate(deletedAt)}
      </span>
    </div>
  );
}

function DeletedBy({ organization }: { organization: AdminOrganization }) {
  if (!organization.deletedAt) {
    return <span className="textSubtle">—</span>;
  }
  return (
    <Identity
      detail={
        organization.deletedByEmail ??
        organization.deletedByUserId ??
        "Not recorded"
      }
      name={organization.deletedByName ?? "Unknown"}
    />
  );
}

function OrganizationActionButton({
  action,
  onMarkForDeletion,
  onRestore,
  organization,
}: OrganizationActions & { organization: AdminOrganization }) {
  if (organization.deletedAt) {
    const restoring =
      action?.organizationId === organization.id && action.type === "restore";
    return (
      <Button
        busy={restoring}
        disabled={action !== undefined}
        icon="restore"
        onClick={() => void onRestore(organization)}
        size="sm"
      >
        {restoring ? "Restoring…" : "Restore"}
      </Button>
    );
  }
  const deleting =
    action?.organizationId === organization.id && action.type === "delete";
  return (
    <Button
      busy={deleting}
      disabled={action !== undefined}
      icon="trash"
      onClick={() => void onMarkForDeletion(organization)}
      size="sm"
      variant="danger"
    >
      {deleting ? "Marking…" : "Mark for deletion"}
    </Button>
  );
}

function UserTable({ users }: { users: ListedUser[] }) {
  return (
    <div className="tableWrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">User</th>
            <th scope="col">Status</th>
            <th scope="col">Role</th>
            <th scope="col">Joined</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => {
            const status = statusFor(user);
            return (
              <tr key={user.id}>
                <td>
                  <Identity avatar detail={user.email} name={user.name} />
                </td>
                <td>
                  <Badge dot tone={status.tone}>
                    {status.label}
                  </Badge>
                </td>
                <td>
                  <RoleBadge role={user.role ?? "user"} />
                </td>
                <td className="adminDate tabular">
                  {formatDate(user.createdAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Identity({
  avatar = false,
  detail,
  name,
}: {
  avatar?: boolean;
  detail?: string | undefined;
  name: string;
}) {
  return (
    <div className="adminIdentity">
      {avatar && <Avatar name={name} size="sm" />}
      <div className="adminIdentityText">
        <span className="adminIdentityName">{name}</span>
        {detail && <span className="adminIdentityDetail">{detail}</span>}
      </div>
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  const roles = role
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return (
    <Badge tone={roles.includes("admin") ? "info" : "neutral"}>
      {roles.map(capitalize).join(", ")}
    </Badge>
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
  const start = page * adminUserPageSize + 1;
  const end = Math.min((page + 1) * adminUserPageSize, total);
  return (
    <nav aria-label="User pages" className="cluster clusterBetween">
      <span className="textSm textSubtle tabular">
        {start}–{end} of {total}
      </span>
      <div className="cluster">
        <Button
          disabled={page === 0}
          icon="arrowLeft"
          onClick={() => onPageChange(page - 1)}
          size="sm"
        >
          Previous
        </Button>
        <Button
          disabled={end >= total}
          iconEnd="arrowRight"
          onClick={() => onPageChange(page + 1)}
          size="sm"
        >
          Next
        </Button>
      </div>
    </nav>
  );
}

function statusFor(user: ListedUser): { label: string; tone: BadgeTone } {
  if (user.banned) return { label: "Banned", tone: "danger" };
  if (user.emailVerified) return { label: "Verified", tone: "success" };
  return { label: "Unverified", tone: "warning" };
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatDate(value: Date | number | string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(new Date(value));
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load users.";
}
