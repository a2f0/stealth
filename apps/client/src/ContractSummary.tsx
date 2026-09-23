import {
  Badge,
  Banner,
  Button,
  ButtonLink,
  Card,
  cx,
  PageSection,
} from "@tearleads/ui/react";
import { useState } from "react";
import { boxStyle, ContractPages } from "./ContractDocument";
import {
  contractStatus,
  describeContractEvent,
  fieldTypeLabel,
  isOverdue,
  recipientStatus,
  recipientTone,
  reminderOptions,
} from "./contractFields";
import {
  type ContractDetail,
  contractDocumentUrl,
  contractFinalUrl,
  deleteContract,
  remindContract,
  voidContract,
} from "./contractsApi";
import { contractPath } from "./workspacePaths";

/** A contract that has been sent: its progress, actions, and history. */
export function ContractSummary({
  contract,
  onChanged,
  onNavigate,
}: {
  contract: ContractDetail;
  onChanged: (contract: ContractDetail) => void;
  onNavigate: (pathname: string) => void;
}) {
  const actions = useSummaryActions(contract, onChanged, onNavigate);
  return (
    <div className="contractSummary">
      {actions.error && <Banner tone="danger">{actions.error}</Banner>}
      {actions.notice && <Banner tone="success">{actions.notice}</Banner>}
      <StatusBanner contract={contract} />
      <div className="contractSummaryGrid">
        <div className="stack">
          <SummaryActions actions={actions} contract={contract} />
          <Signers contract={contract} />
          <Activity contract={contract} />
        </div>
        <PageSection
          title={
            contract.status === "completed" ? "Signed document" : "Document"
          }
        >
          <ContractPages
            key={contract.status}
            load={() =>
              fetchPdf(
                contract.status === "completed"
                  ? contractFinalUrl(contract.id)
                  : contractDocumentUrl(contract.id),
              )
            }
            renderOverlay={(page) =>
              contract.status === "completed"
                ? null
                : contract.fields
                    .filter((field) => field.page === page.number)
                    .map((field) => (
                      <span
                        className={cx(
                          "contractField contractFieldStatic",
                          recipientTone(
                            contract.recipients.findIndex(
                              ({ id }) => id === field.recipientId,
                            ),
                          ),
                        )}
                        key={field.id}
                        style={boxStyle(field)}
                      >
                        <span className="contractFieldLabel">
                          {fieldTypeLabel(field.type)}
                        </span>
                      </span>
                    ))
            }
          />
        </PageSection>
      </div>
    </div>
  );
}

function useSummaryActions(
  contract: ContractDetail,
  onChanged: (contract: ContractDetail) => void,
  onNavigate: (pathname: string) => void,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  async function run(action: () => Promise<string | undefined>) {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setNotice(await action());
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Something went wrong.",
      );
    } finally {
      setBusy(false);
    }
  }
  return {
    busy,
    error,
    notice,
    remind: () =>
      run(async () => {
        const result = await remindContract(contract.id);
        onChanged(result.contract);
        return result.reminded === 1
          ? "Reminder sent to 1 signer."
          : `Reminders sent to ${result.reminded} signers.`;
      }),
    remove: () => {
      if (!window.confirm(`Delete “${contract.title}”? This can't be undone.`))
        return;
      void run(async () => {
        await deleteContract(contract.id);
        onNavigate(contractPath());
        return undefined;
      });
    },
    voidIt: () => {
      const reason = window.prompt(
        `Void “${contract.title}”? Signers will be told it no longer needs signing. Add a reason (optional):`,
      );
      if (reason === null) return;
      void run(async () => {
        onChanged(await voidContract(contract.id, reason));
        return "Contract voided.";
      });
    },
  };
}

function StatusBanner({ contract }: { contract: ContractDetail }) {
  const signed = contract.recipients.filter(
    ({ status }) => status === "signed",
  ).length;
  if (contract.status === "completed") {
    return (
      <Banner icon="success" title="Completed" tone="success">
        Everyone signed. The signed copy, with its certificate of completion,
        was emailed to every signer.
      </Banner>
    );
  }
  if (contract.status === "declined") {
    const decliner = contract.recipients.find(
      ({ status }) => status === "declined",
    );
    return (
      <Banner icon="error" title="Declined" tone="danger">
        {decliner?.name ?? "A signer"} declined to sign
        {decliner?.declineReason ? `: “${decliner.declineReason}”` : "."}
      </Banner>
    );
  }
  if (contract.status === "voided") {
    return (
      <Banner icon="void" title="Voided" tone="neutral">
        This contract was voided
        {contract.voidReason ? `: “${contract.voidReason}”` : "."}
      </Banner>
    );
  }
  return (
    <Banner
      icon={isOverdue(contract) ? "alert" : "send"}
      title={isOverdue(contract) ? "Overdue" : "Waiting for signatures"}
      tone={isOverdue(contract) ? "warning" : "info"}
    >
      {signed} of {contract.recipients.length} signed
      {contract.dueDate ? ` · due ${formatDate(contract.dueDate)}` : ""}
      {" · "}
      {reminderOptions.find(
        ({ value }) => value === contract.reminderIntervalDays,
      )?.label ?? "Custom reminders"}
    </Banner>
  );
}

function SummaryActions({
  actions,
  contract,
}: {
  actions: ReturnType<typeof useSummaryActions>;
  contract: ContractDetail;
}) {
  return (
    <div className="contractSummaryActions">
      {contract.status === "sent" && (
        <>
          <Button
            busy={actions.busy}
            icon="reminder"
            onClick={() => void actions.remind()}
          >
            Send reminder
          </Button>
          <Button
            disabled={actions.busy}
            icon="void"
            onClick={actions.voidIt}
            variant="danger"
          >
            Void
          </Button>
        </>
      )}
      {contract.status === "completed" && (
        <ButtonLink
          href={contractFinalUrl(contract.id)}
          icon="download"
          variant="primary"
        >
          Download signed PDF
        </ButtonLink>
      )}
      <ButtonLink href={contractDocumentUrl(contract.id)} icon="download">
        Original
      </ButtonLink>
      {contract.status !== "sent" && (
        <Button
          disabled={actions.busy}
          icon="trash"
          onClick={actions.remove}
          variant="ghost"
        >
          Delete
        </Button>
      )}
    </div>
  );
}

function Signers({ contract }: { contract: ContractDetail }) {
  const ordered = contract.signingOrder === "sequential";
  return (
    <Card flush title={ordered ? "Signers, in order" : "Signers"}>
      <ul className="rowList">
        {contract.recipients.map((recipient, index) => {
          const status = recipientStatus(recipient.status);
          return (
            <li
              className={cx("row contractSignerRow", recipientTone(index))}
              key={recipient.id}
            >
              <span aria-hidden="true" className="contractSignerSwatch" />
              <span className="rowMain">
                <span className="rowTitle truncate">
                  {ordered ? `${recipient.routingOrder}. ` : ""}
                  {recipient.name}
                </span>
                <span className="rowMeta truncate">
                  {recipient.email}
                  {recipient.signedAt
                    ? ` · signed ${formatDateTime(recipient.signedAt)}`
                    : ""}
                  {!recipient.signedAt && recipient.viewedAt
                    ? ` · opened ${formatDateTime(recipient.viewedAt)}`
                    : ""}
                </span>
              </span>
              <Badge dot tone={status.tone}>
                {status.label}
              </Badge>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function Activity({ contract }: { contract: ContractDetail }) {
  const names = new Map(contract.recipients.map(({ id, name }) => [id, name]));
  return (
    <Card title="Activity">
      <ol className="contractActivity">
        {[...contract.events].reverse().map((event) => (
          <li
            className={cx(
              event.type === "delivery_failed" && "contractActivityProblem",
            )}
            key={event.id}
          >
            <span>{describeContractEvent(event, names)}</span>
            <time dateTime={event.createdAt}>
              {formatDateTime(event.createdAt)}
            </time>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** The status badge shown in lists and headers. */
export function ContractStatusBadge({
  contract,
}: {
  contract: Pick<ContractDetail, "dueDate" | "status">;
}) {
  const status = contractStatus(contract);
  return (
    <Badge dot tone={status.tone}>
      {status.label}
    </Badge>
  );
}

async function fetchPdf(url: string) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error("The document could not be loaded.");
  return response.arrayBuffer();
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(`${value}T12:00:00`),
  );
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
