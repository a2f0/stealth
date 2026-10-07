import {
  Badge,
  Banner,
  Button,
  ButtonLink,
  EmptyState,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
} from "@tearleads/ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatDate, Identity } from "./adminDisplay";
import {
  type AdminOrganizationDetail,
  type AdminOrganizationRequirement,
  getAdminOrganization,
} from "./api";
import { countLabel } from "./labels";
import type { OrganizationMember } from "./organizationSettingsApi";

export function AdminOrganizationDetails({
  onNavigate,
  organizationId,
}: {
  onNavigate: (pathname: string) => void;
  organizationId: string;
}) {
  const [detail, setDetail] = useState<AdminOrganizationDetail>();
  const [error, setError] = useState<string>();
  const requestSequence = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setDetail(undefined);
    setError(undefined);
    try {
      const result = await getAdminOrganization(organizationId);
      if (requestId === requestSequence.current) setDetail(result);
    } catch (cause) {
      if (requestId === requestSequence.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not load organization details.",
        );
      }
    }
  }, [organizationId]);
  useEffect(() => {
    void load();
    return () => {
      requestSequence.current += 1;
    };
  }, [load]);
  const busy = !detail && !error;
  return (
    <Page>
      <PageHeader
        actions={
          <Button busy={busy} icon="refresh" onClick={() => void load()}>
            {busy ? "Loading…" : "Refresh"}
          </Button>
        }
        back={
          <Button
            onClick={() => onNavigate("/root/organizations")}
            size="sm"
            variant="link"
          >
            ← Organizations
          </Button>
        }
        description="Organization details, people, and employee checks."
        eyebrow="Root Admin"
        title={detail?.organization.name ?? "Organization details"}
      />
      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}
        {detail ? (
          <>
            <OrganizationOverview organization={detail.organization} />
            <OrganizationPeople members={detail.members} />
            <OrganizationRequirements requirements={detail.requirements} />
          </>
        ) : busy ? (
          <LoadingState label="Loading organization details…" />
        ) : null}
      </PageBody>
    </Page>
  );
}

function OrganizationOverview({
  organization,
}: {
  organization: AdminOrganizationDetail["organization"];
}) {
  return (
    <PageSection title="Overview">
      <dl className="keyValue">
        <dt>Status</dt>
        <dd>
          <Badge tone={organization.deletedAt ? "danger" : "success"}>
            {organization.deletedAt ? "Pending deletion" : "Active"}
          </Badge>
        </dd>
        <dt>Owner</dt>
        <dd>
          {organization.ownerName || organization.ownerEmail ? (
            <Identity
              detail={organization.ownerEmail ?? undefined}
              name={organization.ownerName ?? organization.ownerEmail ?? ""}
            />
          ) : (
            "No default owner"
          )}
        </dd>
        <dt>Slug</dt>
        <dd className="mono">{organization.slug}</dd>
        <dt>Created</dt>
        <dd>{formatDate(organization.createdAt)}</dd>
      </dl>
    </PageSection>
  );
}

function OrganizationPeople({ members }: { members: OrganizationMember[] }) {
  return (
    <PageSection
      actions={
        <span className="sectionCount">
          {countLabel(members.length, "member", "members")}
        </span>
      }
      title="People"
    >
      {members.length === 0 ? (
        <EmptyState compact icon="organization" title="No members found." />
      ) : (
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col">Two-factor authentication</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id}>
                  <td>
                    <Identity
                      detail={member.user.email}
                      name={member.user.name}
                    />
                  </td>
                  <td>{formatStatus(member.role)}</td>
                  <td>{member.twoFactorEnabled ? "Enabled" : "Not enabled"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageSection>
  );
}

function OrganizationRequirements({
  requirements,
}: {
  requirements: AdminOrganizationRequirement[];
}) {
  return (
    <PageSection title="Employee forms and checks">
      {requirements.length === 0 ? (
        <EmptyState
          compact
          icon="check"
          title="No requirements assigned yet."
        />
      ) : (
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Requirement</th>
                <th scope="col">Person</th>
                <th scope="col">Due</th>
                <th scope="col">Status</th>
                <th scope="col">Checkr result</th>
                <th scope="col">Report</th>
              </tr>
            </thead>
            <tbody>
              {requirements.map((requirement) => (
                <tr key={requirement.id}>
                  <td>{requirement.title}</td>
                  <td>
                    <Identity
                      detail={
                        requirement.targetName
                          ? requirement.targetEmail
                          : undefined
                      }
                      name={requirement.targetName ?? requirement.targetEmail}
                    />
                  </td>
                  <td className="adminDate">
                    {formatDate(new Date(`${requirement.dueDate}T12:00:00`))}
                  </td>
                  <td>
                    <Badge
                      tone={
                        requirement.status === "complete"
                          ? "success"
                          : "neutral"
                      }
                    >
                      {formatStatus(requirement.status)}
                    </Badge>
                  </td>
                  <td>
                    <ScreeningResult requirement={requirement} />
                  </td>
                  <td>
                    {requirement.checkrReportUrl ? (
                      <ButtonLink
                        aria-label={`View ${requirement.title} report for ${requirement.targetName ?? requirement.targetEmail}`}
                        href={requirement.checkrReportUrl}
                        rel="noopener noreferrer"
                        size="sm"
                        target="_blank"
                      >
                        View report
                      </ButtonLink>
                    ) : (
                      <span className="textSubtle">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageSection>
  );
}

function ScreeningResult({
  requirement,
}: {
  requirement: AdminOrganizationRequirement;
}) {
  if (requirement.kind === "form") return <span className="textSubtle">—</span>;
  return (
    <div className="adminStatus">
      {requirement.checkrResult ? (
        <Badge
          tone={
            requirement.checkrResult === "clear"
              ? "success"
              : requirement.checkrResult === "consider"
                ? "warning"
                : "neutral"
          }
        >
          {formatStatus(requirement.checkrResult)}
        </Badge>
      ) : (
        <span>
          {formatStatus(requirement.checkrInvitationStatus ?? "Not started")}
        </span>
      )}
      {requirement.completedAt && (
        <span className="textXs textSubtle">
          Completed {formatDate(requirement.completedAt)}
        </span>
      )}
      {requirement.checkrResult === "consider" && (
        <span className="textXs textSubtle">Review the report in Checkr.</span>
      )}
    </div>
  );
}

function formatStatus(value: string) {
  const label = value.replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}
