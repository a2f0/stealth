import {
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
import { useCallback, useEffect, useState } from "react";
import { formatDate, Identity } from "./adminDisplay";
import { adminUserListQuery, adminUserPageSize } from "./adminUserList";
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

export function AdminUsers() {
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
        query: adminUserListQuery(page),
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
    <Page>
      <PageHeader
        actions={
          <Button busy={busy} icon="refresh" onClick={() => void loadUsers()}>
            {busy ? "Loading…" : "Refresh"}
          </Button>
        }
        description="Every account on the platform."
        eyebrow="Root Admin"
        title="Users"
      />
      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}
        <UserSection
          busy={busy}
          hasError={Boolean(error)}
          listing={listing}
          onPageChange={setPage}
          page={page}
        />
      </PageBody>
    </Page>
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

function UserTable({ users }: { users: ListedUser[] }) {
  return (
    <div className="tableWrap">
      <table className="table adminUsersTable">
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

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load users.";
}
