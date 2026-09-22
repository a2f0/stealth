import { Banner, Button, Card, Icon, LoadingState } from "@tearleads/ui/react";
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
  onUseAnotherAccount,
}: {
  invitationId: string | null;
  onAccepted: () => Promise<void>;
  onNavigate: () => void;
  onUseAnotherAccount: () => void;
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
    <div className="acceptInvitePage">
      <div className="acceptInvitePanel">
        <header className="acceptInviteHeader">
          <span aria-hidden="true" className="acceptInviteMark">
            <Icon name={accepted ? "success" : "mail"} size={22} />
          </span>
          <p className="eyebrow">Organization invitation</p>
          <h1 className="acceptInviteTitle">
            {accepted ? "You’re in" : "Join your team"}
          </h1>
        </header>
        {error && !isRecipientMismatch(error) && (
          <Banner tone="danger">{error}</Banner>
        )}
        {error && isRecipientMismatch(error) && (
          <WrongAccount onUseAnotherAccount={onUseAnotherAccount} />
        )}
        <InvitationStatus
          accepted={accepted}
          busy={busy}
          invitation={invitation}
          onAccept={() => void accept()}
          onNavigate={onNavigate}
        />
      </div>
    </div>
  );
}

function InvitationStatus({
  accepted,
  busy,
  invitation,
  onAccept,
  onNavigate,
}: {
  accepted: boolean;
  busy: boolean;
  invitation: InvitationDetails | undefined;
  onAccept: () => void;
  onNavigate: () => void;
}) {
  if (accepted && invitation) {
    return (
      <Card
        description="The organization is active for this session."
        title={`Welcome to ${invitation.organizationName}`}
      >
        <Button
          block
          iconEnd="arrowRight"
          onClick={onNavigate}
          variant="primary"
        >
          Open organization
        </Button>
      </Card>
    );
  }
  if (invitation) {
    return (
      <Card
        description={`Invited by ${invitation.inviterEmail} as ${invitation.role}.`}
        title={`Join ${invitation.organizationName}`}
      >
        <dl className="keyValue">
          <dt>Invited email</dt>
          <dd>{invitation.email}</dd>
          <dt>Expires</dt>
          <dd>{formatDate(invitation.expiresAt)}</dd>
        </dl>
        <Button block busy={busy} onClick={onAccept} variant="primary">
          {busy ? "Joining…" : "Accept invitation"}
        </Button>
      </Card>
    );
  }
  if (busy) {
    return (
      <Card>
        <LoadingState label="Loading invitation…" />
      </Card>
    );
  }
  return null;
}

function WrongAccount({
  onUseAnotherAccount,
}: {
  onUseAnotherAccount: () => void;
}) {
  return (
    <Card
      description="Switch to the invited account from the account menu, or sign in to another account. You’ll return to this invitation."
      title="This invitation belongs to another account"
    >
      <Button
        block
        icon="userAdd"
        onClick={onUseAnotherAccount}
        variant="primary"
      >
        Sign in to another account
      </Button>
    </Card>
  );
}

function isRecipientMismatch(message: string) {
  return message.toLowerCase().includes("not the recipient");
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
