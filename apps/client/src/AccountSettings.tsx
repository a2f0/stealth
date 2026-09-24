import {
  Banner,
  Button,
  Card,
  Field,
  Page,
  PageBody,
  PageHeader,
} from "@tearleads/ui/react";
import { type FormEvent, type MouseEvent, useEffect, useState } from "react";
import { AccountSecurity } from "./AccountSecurity";
import { saveDefaultOrganizationPreference } from "./accountSettingsApi";
import type { WorkspaceOrganization } from "./organizationState";

export function AccountSettings({
  defaultOrganizationId,
  onNavigate,
  onSessionChanged,
  organizations,
  pathname,
  twoFactorEnabled,
}: {
  defaultOrganizationId: string | null | undefined;
  onNavigate: (pathname: string) => void;
  onSessionChanged: () => Promise<unknown>;
  organizations: WorkspaceOrganization[];
  pathname: string;
  twoFactorEnabled: boolean;
}) {
  const security = pathname === "/account/security";
  return (
    <Page narrow>
      <PageHeader
        description={
          security
            ? "Protect your account with a second step at sign-in."
            : "Choose how your account opens."
        }
        eyebrow="Account"
        tabs={
          <>
            <AccountTab
              active={!security}
              label="General"
              onNavigate={onNavigate}
              path="/account"
            />
            <AccountTab
              active={security}
              label="Security"
              onNavigate={onNavigate}
              path="/account/security"
            />
          </>
        }
        tabsLabel="Account settings"
        title="Account settings"
      />
      <PageBody>
        {security ? (
          <AccountSecurity
            onSecurityChanged={onSessionChanged}
            twoFactorEnabled={twoFactorEnabled}
          />
        ) : (
          <AccountGeneral
            defaultOrganizationId={defaultOrganizationId}
            onSessionChanged={onSessionChanged}
            organizations={organizations}
          />
        )}
      </PageBody>
    </Page>
  );
}

function AccountTab({
  active,
  label,
  onNavigate,
  path,
}: {
  active: boolean;
  label: string;
  onNavigate: (pathname: string) => void;
  path: string;
}) {
  function navigate(event: MouseEvent<HTMLAnchorElement>) {
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
    onNavigate(path);
  }
  return (
    <a
      aria-current={active ? "page" : undefined}
      className="tab"
      href={path}
      onClick={navigate}
    >
      {label}
    </a>
  );
}

function AccountGeneral({
  defaultOrganizationId,
  onSessionChanged,
  organizations,
}: {
  defaultOrganizationId: string | null | undefined;
  onSessionChanged: () => Promise<unknown>;
  organizations: WorkspaceOrganization[];
}) {
  const current = organizations.some(({ id }) => id === defaultOrganizationId)
    ? defaultOrganizationId
    : organizations[0]?.id;
  const [selected, setSelected] = useState(current ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => setSelected(current ?? ""), [current]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await saveDefaultOrganizationPreference(selected, onSessionChanged);
      setNotice("Default organization saved.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save your default organization.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Card
        description="This organization opens when you sign in."
        footer={
          <Button
            busy={saving}
            disabled={saving || !selected}
            type="submit"
            variant="primary"
          >
            Save changes
          </Button>
        }
        onSubmit={(event) => void save(event)}
        title="Default organization"
      >
        <Field label="Organization">
          <select
            className="select"
            disabled={saving || organizations.length === 0}
            onChange={(event) => {
              setSelected(event.target.value);
              setError(undefined);
              setNotice(undefined);
            }}
            value={selected}
          >
            {organizations.length === 0 && (
              <option value="">No organizations available</option>
            )}
            {organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
              </option>
            ))}
          </select>
        </Field>
      </Card>
      {error && <Banner tone="danger">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}
    </>
  );
}
