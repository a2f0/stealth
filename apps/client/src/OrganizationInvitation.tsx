import { useEffect, useState } from "react";
import { authClient } from "./authClient";

interface InvitationDetails {
  email: string;
  expiresAt: Date;
  id: string;
  inviterEmail: string;
  organizationName: string;
  role: string;
}

export function OrganizationInvitation({
  invitationId,
  onAccepted,
  onNavigate,
}: {
  invitationId: string | null;
  onAccepted: () => Promise<void>;
  onNavigate: () => void;
}) {
  const [invitation, setInvitation] = useState<InvitationDetails>();
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!invitationId) {
      setError("This invitation link is missing its ID.");
      setBusy(false);
      return;
    }
    let active = true;
    void authClient.organization
      .getInvitation({ query: { id: invitationId } })
      .then((result) => {
        if (!active) return;
        if (result.error) {
          setError(
            result.error.message ?? "This invitation is invalid or expired.",
          );
          return;
        }
        setInvitation(result.data as InvitationDetails);
      })
      .catch((cause: unknown) => {
        if (active) setError(messageFrom(cause));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [invitationId]);

  async function accept() {
    if (!invitationId) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await authClient.organization.acceptInvitation({
        invitationId,
      });
      if (result.error) {
        throw new Error(
          result.error.message ?? "Could not accept this invitation.",
        );
      }
      setAccepted(true);
      await onAccepted();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">Organization invitation</p>
          <h1>{accepted ? "You’re in" : "Join your team"}</h1>
        </div>
      </header>
      <section className="content invitationContent">
        {error && <div className="errorBanner">{error}</div>}
        {accepted && invitation ? (
          <div className="settingsCard invitationCard">
            <div>
              <h2>Welcome to {invitation.organizationName}</h2>
              <p>The organization is active for this session.</p>
            </div>
            <button
              className="primaryButton settingsSubmit"
              onClick={onNavigate}
              type="button"
            >
              Open organization
            </button>
          </div>
        ) : invitation ? (
          <div className="settingsCard invitationCard">
            <div>
              <h2>Join {invitation.organizationName}</h2>
              <p>
                Invited by {invitation.inviterEmail} as {invitation.role}.
              </p>
            </div>
            <dl className="invitationDetails">
              <div>
                <dt>Invited email</dt>
                <dd>{invitation.email}</dd>
              </div>
              <div>
                <dt>Expires</dt>
                <dd>{formatDate(invitation.expiresAt)}</dd>
              </div>
            </dl>
            <button
              className="primaryButton settingsSubmit"
              disabled={busy}
              onClick={() => void accept()}
              type="button"
            >
              {busy ? "Joining…" : "Accept invitation"}
            </button>
          </div>
        ) : busy ? (
          <p className="auditLoading">Loading invitation…</p>
        ) : null}
      </section>
    </>
  );
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function messageFrom(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "Could not load this invitation.";
}
