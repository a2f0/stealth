import {
  Banner,
  Button,
  Card,
  EmptyState,
  Icon,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
} from "@tearleads/ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ContractEditor } from "./ContractEditor";
import {
  ContractStatusBadge,
  ContractSummary,
  formatDate,
} from "./ContractSummary";
import {
  type ContractFilter,
  contractFilters,
  matchesFilter,
} from "./contractFields";
import {
  type ContractDetail,
  type ContractSummary as ContractListItem,
  getContract,
  listContracts,
  uploadContract,
} from "./contractsApi";
import { countLabel } from "./labels";
import {
  contractIdForPath,
  contractPath,
  handleNavigation,
} from "./workspacePaths";

export function Contracts({
  onNavigate,
  pathname,
}: {
  onNavigate: (pathname: string) => void;
  pathname: string;
}) {
  const contractId = contractIdForPath(pathname);
  // Keyed so each page starts fresh and ignores the other's late responses.
  return contractId ? (
    <ContractPage id={contractId} key={contractId} onNavigate={onNavigate} />
  ) : (
    <ContractListPage onNavigate={onNavigate} />
  );
}

function useContractList(onNavigate: (pathname: string) => void) {
  const [contracts, setContracts] = useState<ContractListItem[]>();
  const [error, setError] = useState<string>();
  const [uploading, setUploading] = useState(false);
  useEffect(() => {
    let active = true;
    listContracts()
      .then((result) => {
        if (active) setContracts(result);
      })
      .catch((cause: unknown) => {
        if (active) setError(messageFrom(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  async function upload(file: File) {
    setUploading(true);
    setError(undefined);
    try {
      const created = await uploadContract(file);
      onNavigate(contractPath(created.id));
    } catch (cause) {
      setError(messageFrom(cause));
      setUploading(false);
    }
  }
  return { contracts, error, upload, uploading };
}

function ContractListPage({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const { contracts, error, upload, uploading } = useContractList(onNavigate);
  const [filter, setFilter] = useState<ContractFilter>("all");
  const fileInput = useRef<HTMLInputElement>(null);
  const choose = () => fileInput.current?.click();
  const visible = (contracts ?? []).filter(({ status }) =>
    matchesFilter(status, filter),
  );
  return (
    <Page>
      <PageHeader
        actions={
          <Button
            busy={uploading}
            icon="add"
            onClick={choose}
            variant="primary"
          >
            New contract
          </Button>
        }
        description="Send documents for signature, track who has signed, and keep the signed copies."
        eyebrow="Records"
        title="Contracts"
      />
      <input
        accept="application/pdf,.pdf"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = "";
        }}
        ref={fileInput}
        type="file"
      />
      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}
        {!contracts ? (
          !error && <LoadingState label="Loading contracts…" />
        ) : contracts.length === 0 ? (
          <EmptyState
            actions={
              <Button
                busy={uploading}
                icon="add"
                onClick={choose}
                variant="primary"
              >
                Upload a PDF
              </Button>
            }
            icon="contract"
            title="No contracts yet"
          >
            Upload a PDF, add signers, and place where each of them signs. They
            get an email link and don’t need an account.
          </EmptyState>
        ) : (
          <PageSection
            actions={
              <span className="sectionCount">
                {countLabel(visible.length, "contract")}
              </span>
            }
            title="All contracts"
          >
            <nav
              aria-label="Contract status"
              className="segmented contractFilters"
            >
              {contractFilters.map((option) => (
                <button
                  aria-pressed={filter === option.value}
                  key={option.value}
                  onClick={() => setFilter(option.value)}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </nav>
            <ContractList contracts={visible} onNavigate={onNavigate} />
          </PageSection>
        )}
      </PageBody>
    </Page>
  );
}

function ContractList({
  contracts,
  onNavigate,
}: {
  contracts: ContractListItem[];
  onNavigate: (pathname: string) => void;
}) {
  if (contracts.length === 0) {
    return (
      <EmptyState compact icon="search" title="No contracts in this view" />
    );
  }
  return (
    <Card flush>
      <ul className="rowList contractList">
        {contracts.map((contract) => {
          const path = contractPath(contract.id);
          return (
            <li key={contract.id}>
              <a
                className="row contractRow"
                href={path}
                onClick={(event) => handleNavigation(event, path, onNavigate)}
              >
                <span className="contractRowMark">
                  <Icon name="contract" size={20} />
                </span>
                <span className="rowMain">
                  <span className="rowTitle truncate">{contract.title}</span>
                  <span className="rowMeta truncate">
                    {contractMeta(contract)}
                  </span>
                </span>
                <ContractStatusBadge contract={contract} />
              </a>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function ContractPage({
  id,
  onNavigate,
}: {
  id: string;
  onNavigate: (pathname: string) => void;
}) {
  const [contract, setContract] = useState<ContractDetail>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      setContract(await getContract(id));
    } catch (cause) {
      setError(messageFrom(cause));
    }
  }, [id]);
  useEffect(() => void load(), [load]);
  return (
    <Page className="contractPageLayout">
      <PageHeader
        actions={contract && <ContractStatusBadge contract={contract} />}
        back={
          <Button
            icon="arrowLeft"
            onClick={() => onNavigate(contractPath())}
            size="sm"
            variant="ghost"
          >
            Contracts
          </Button>
        }
        description={contract?.document.filename}
        eyebrow={contract?.status === "draft" ? "Draft contract" : "Contract"}
        title={contract?.title ?? (error ? "Contract unavailable" : "Loading…")}
      />
      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}
        {!contract ? (
          !error && <LoadingState label="Loading contract…" />
        ) : contract.status === "draft" ? (
          <ContractEditor
            contract={contract}
            onChanged={setContract}
            onDeleted={() => onNavigate(contractPath())}
          />
        ) : (
          <ContractSummary
            contract={contract}
            onChanged={setContract}
            onNavigate={onNavigate}
          />
        )}
      </PageBody>
    </Page>
  );
}

function contractMeta(contract: ContractListItem) {
  const parts = [
    contract.signerCount
      ? `${contract.signedCount} of ${countLabel(contract.signerCount, "signer")} signed`
      : "No signers yet",
  ];
  if (contract.dueDate) parts.push(`due ${formatDate(contract.dueDate)}`);
  if (contract.senderName) parts.push(`from ${contract.senderName}`);
  return parts.join(" · ");
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load contracts.";
}
