import { EmptyState, Page, PageBody, PageHeader } from "@tearleads/ui/react";
import { BillingLink, billingPath } from "./BillingLink";
import type { OrganizationSeatRequirement } from "./organizationGroupsApi";

/** The seat requirement that blocks `pathname`; owners keep Billing open. */
export function blockingSeatRequirement(
  requirement: OrganizationSeatRequirement | undefined,
  pathname: string,
) {
  return requirement === "upgrade" && pathname === billingPath
    ? undefined
    : requirement;
}

/** Stands in for organization pages while the Free plan has no seat for you. */
export function OrganizationSeatRequired({
  onNavigate,
  requirement,
}: {
  onNavigate: (pathname: string) => void;
  requirement: OrganizationSeatRequirement;
}) {
  const canUpgrade = requirement === "upgrade";
  return (
    <Page narrow>
      <PageHeader eyebrow="Organization billing" title="Upgrade required" />
      <PageBody>
        <EmptyState
          actions={
            canUpgrade ? (
              <BillingLink onNavigate={onNavigate} variant="primary" />
            ) : null
          }
          icon="lock"
          title={
            canUpgrade
              ? "Upgrade to Pro to restore your access"
              : "This organization has no seat for you"
          }
        >
          <p>
            {canUpgrade
              ? "This organization’s Free plan includes one user, and another owner holds that seat. Upgrade to Pro on the Billing page to use this workspace."
              : "This organization’s Free plan includes one user. Ask an owner to upgrade to Pro or remove another member. You can switch organizations from the sidebar."}
          </p>
        </EmptyState>
      </PageBody>
    </Page>
  );
}
