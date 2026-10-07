import {
  Badge,
  Banner,
  Button,
  confirmDialog,
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
import { AdminOrganizationDetails } from "./AdminOrganizationDetails";
import { formatDate, Identity } from "./adminDisplay";
import {
  type AdminOrganization,
  listAdminOrganizations,
  markAdminOrganizationForDeletion,
  restoreAdminOrganization,
} from "./api";
import { countLabel } from "./labels";
import { adminOrganizationIdForPath } from "./organizationState";

interface AdminOrganizationAction {
  organizationId: string;
  type: "delete" | "restore";
}

interface OrganizationActions {
  action: AdminOrganizationAction | undefined;
  onMarkForDeletion: (organization: AdminOrganization) => Promise<void>;
  onRestore: (organization: AdminOrganization) => Promise<void>;
}

interface OrganizationTableActions extends OrganizationActions {
  onNavigate: (pathname: string) => void;
}

export function AdminOrganizations({
  onNavigate,
  pathname = "/root/organizations",
}: {
  onNavigate: (pathname: string) => void;
  pathname?: string | undefined;
}) {
  const organizationId = adminOrganizationIdForPath(pathname);
  return organizationId ? (
    <AdminOrganizationDetails
      key={organizationId}
      onNavigate={onNavigate}
      organizationId={organizationId}
    />
  ) : (
    <AdminOrganizationList onNavigate={onNavigate} />
  );
}

function AdminOrganizationList({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const [organizations, setOrganizations] = useState<AdminOrganization[]>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const lifecycle = useAdminOrganizationLifecycle(setOrganizations);

  const loadOrganizations = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    setOrganizations(undefined);
    try {
      setOrganizations(await listAdminOrganizations());
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadOrganizations();
  }, [loadOrganizations]);

  return (
    <Page>
      <PageHeader
        actions={
          <Button
            busy={busy}
            icon="refresh"
            onClick={() => void loadOrganizations()}
          >
            {busy ? "Loading…" : "Refresh"}
          </Button>
        }
        description="Every organization on the platform."
        eyebrow="Root Admin"
        title="Organizations"
      />
      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}
        {lifecycle.error && <Banner tone="danger">{lifecycle.error}</Banner>}
        {lifecycle.notice && <Banner tone="success">{lifecycle.notice}</Banner>}
        <OrganizationSection
          action={lifecycle.action}
          busy={busy}
          onMarkForDeletion={lifecycle.markForDeletion}
          onNavigate={onNavigate}
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
    if (!(await confirmMarkForDeletion(organization))) return;

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
    if (!(await confirmRestore(organization))) return;

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

function OrganizationSection({
  action,
  busy,
  onMarkForDeletion,
  onNavigate,
  onRestore,
  organizations,
}: OrganizationTableActions & {
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
      title="All organizations"
    >
      {organizations && organizations.length > 0 ? (
        <OrganizationTable
          action={action}
          onMarkForDeletion={onMarkForDeletion}
          onNavigate={onNavigate}
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
  onNavigate,
  onRestore,
  organizations,
}: OrganizationTableActions & { organizations: AdminOrganization[] }) {
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
              onNavigate={onNavigate}
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
  onNavigate,
  onRestore,
  organization,
}: OrganizationTableActions & { organization: AdminOrganization }) {
  return (
    <tr>
      <td>
        <div className="adminIdentityText adminOrganization">
          <a
            className="adminOrganizationName adminOrganizationLink"
            href={`/root/organizations/${encodeURIComponent(organization.id)}`}
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              ) {
                return;
              }
              event.preventDefault();
              onNavigate(
                `/root/organizations/${encodeURIComponent(organization.id)}`,
              );
            }}
          >
            {organization.name}
          </a>
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

function messageFrom(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "Could not load organizations.";
}

function confirmMarkForDeletion(organization: AdminOrganization) {
  return confirmDialog({
    confirmLabel: "Mark for deletion",
    message:
      "It will become unavailable immediately, and its data can be permanently purged after 30 days.",
    title: `Mark ${organization.name} for deletion?`,
    tone: "danger",
    typeToConfirm: organization.name,
  });
}

function confirmRestore(organization: AdminOrganization) {
  return confirmDialog({
    confirmLabel: "Restore",
    message:
      "Existing members who do not have another default organization will regain access.",
    title: `Restore ${organization.name}?`,
  });
}
