import {
  Banner,
  Button,
  Card,
  confirmDialog,
  EmptyState,
  Field,
  Icon,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  Toast,
} from "@tearleads/ui/react";
import { useEffect, useRef, useState } from "react";
import { formatDate } from "./ContractSummary";
import { ContractTemplateEditor } from "./ContractTemplateEditor";
import { ContractTemplateMapping } from "./ContractTemplateMapping";
import {
  type ContractTemplate,
  type ContractTemplateSummary,
  deleteContractTemplate,
  getContractTemplate,
  listContractTemplates,
  listTemplateVersions,
  type TemplateVersion,
  uploadContractTemplate,
} from "./contractTemplatesApi";
import { confirmDiscardChanges } from "./unsavedChanges";
import {
  contractPath,
  contractTemplateIdForPath,
  contractTemplatePath,
  handleNavigation,
} from "./workspacePaths";

export function ContractTemplates({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate: (pathname: string) => void;
}) {
  const id = contractTemplateIdForPath(pathname);
  return id ? (
    <TemplatePage id={id} key={id} onNavigate={onNavigate} />
  ) : (
    <TemplateList onNavigate={onNavigate} />
  );
}

function TemplateList({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const [templates, setTemplates] = useState<ContractTemplateSummary[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploading = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    listContractTemplates()
      .then((result) => {
        if (active) setTemplates(result);
      })
      .catch((cause: unknown) => {
        if (active) setError(messageFrom(cause));
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, []);
  async function upload(file: File) {
    if (uploading.current) return;
    uploading.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const template = await uploadContractTemplate(file);
      if (mounted.current) onNavigate(contractTemplatePath(template.id));
    } catch (cause) {
      if (!mounted.current) return;
      setError(messageFrom(cause));
      setBusy(false);
      uploading.current = false;
    }
  }
  const choose = () => fileInput.current?.click();
  return (
    <Page>
      <PageHeader
        actions={
          <Button busy={busy} icon="add" onClick={choose} variant="primary">
            New template
          </Button>
        }
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
        description="Place fields once, then map signer roles to people each time you use a template."
        eyebrow="Contracts"
        title="Contract templates"
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
        {!templates ? (
          !error && <LoadingState label="Loading templates…" />
        ) : templates.length === 0 ? (
          <EmptyState
            actions={
              <Button busy={busy} icon="add" onClick={choose} variant="primary">
                Upload a PDF
              </Button>
            }
            icon="contract"
            title="No contract templates yet"
          >
            Upload a document, add signer roles, and draw their fields. Saved
            versions stay available for future contracts.
          </EmptyState>
        ) : (
          <Card flush>
            <ul className="rowList contractList">
              {templates.map((template) => {
                const path = contractTemplatePath(template.id);
                return (
                  <li key={template.id}>
                    <a
                      className="row contractRow"
                      href={path}
                      onClick={(event) =>
                        handleNavigation(event, path, onNavigate)
                      }
                    >
                      <span className="contractRowMark">
                        <Icon name="contract" size={20} />
                      </span>
                      <span className="rowMain">
                        <span className="rowTitle truncate">
                          {template.name}
                        </span>
                        <span className="rowMeta truncate">
                          {template.description || "Reusable contract"} · v
                          {template.currentVersion}
                        </span>
                      </span>
                      <Icon name="chevronRight" size={16} />
                    </a>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </PageBody>
    </Page>
  );
}

function TemplatePage({
  id,
  onNavigate,
}: {
  id: string;
  onNavigate: (pathname: string) => void;
}) {
  const page = useTemplatePage(id, onNavigate);
  const {
    template,
    error,
    notice,
    setNotice,
    setDirty,
    mapping,
    setMapping,
    loading,
    saved,
    deleting,
    setWorking,
  } = page;
  return (
    <Page className="contractPageLayout">
      <PageHeader
        actions={template && <TemplateActions page={page} />}
        back={
          <Button
            icon="arrowLeft"
            onClick={() => {
              onNavigate(contractTemplatePath());
            }}
            size="sm"
            variant="ghost"
          >
            Templates
          </Button>
        }
        description={template?.document.filename}
        eyebrow={
          template
            ? `Contract template · v${template.version}`
            : "Contract template"
        }
        title={template?.name ?? (error ? "Template unavailable" : "Loading…")}
      />
      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}
        {notice && (
          <Toast
            actions={
              <Button
                aria-label="Dismiss notification"
                icon="close"
                iconOnly
                onClick={() => setNotice(undefined)}
                size="sm"
                variant="ghost"
              />
            }
            tone="success"
          >
            {notice}
          </Toast>
        )}
        {!template || loading ? (
          !error && <LoadingState label="Loading template…" />
        ) : mapping ? (
          <ContractTemplateMapping
            key={`${id}:${template.version}:mapping`}
            onBusyChange={setWorking}
            onCancel={() => setMapping(false)}
            onCreated={(contractId) => onNavigate(contractPath(contractId))}
            template={template}
          />
        ) : (
          <ContractTemplateEditor
            disabled={deleting}
            key={`${id}:${template.version}`}
            onBusyChange={setWorking}
            onDirtyChange={setDirty}
            onSaved={saved}
            template={template}
          />
        )}
      </PageBody>
    </Page>
  );
}

function messageFrom(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "Could not load contract templates.";
}

type TemplatePageState = ReturnType<typeof useTemplatePage>;
function useTemplatePage(id: string, onNavigate: (pathname: string) => void) {
  const [template, setTemplate] = useState<ContractTemplate>();
  const [versions, setVersions] = useState<TemplateVersion[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const [mapping, setMapping] = useState(false);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [working, setWorking] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    Promise.all([getContractTemplate(id), listTemplateVersions(id)])
      .then(([loaded, history]) => {
        if (active) {
          setTemplate(loaded);
          setVersions(history);
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(messageFrom(cause));
      });
    return () => {
      active = false;
      generation.current += 1;
    };
  }, [id]);
  const discard = async () => !dirty || (await confirmDiscardChanges());
  async function selectVersion(version: number) {
    if (!(await discard())) return;
    const request = ++generation.current;
    setLoading(true);
    setError(undefined);
    try {
      const loaded = await getContractTemplate(id, version);
      if (generation.current === request) {
        setTemplate(loaded);
        setDirty(false);
        setMapping(false);
      }
    } catch (cause) {
      if (generation.current === request) setError(messageFrom(cause));
    } finally {
      if (generation.current === request) setLoading(false);
    }
  }
  function saved(value: ContractTemplate) {
    setTemplate(value);
    setDirty(false);
    setNotice(`Version ${value.version} saved.`);
    setVersions((current) => [versionSummary(value), ...current]);
  }
  async function remove() {
    if (!(await confirmTemplateDeletion())) return;
    const request = generation.current;
    setDeleting(true);
    setError(undefined);
    try {
      await deleteContractTemplate(id);
      if (generation.current === request) onNavigate(contractTemplatePath());
    } catch (cause) {
      if (generation.current !== request) return;
      setError(messageFrom(cause));
      setDeleting(false);
    }
  }
  return {
    template,
    versions,
    error,
    notice,
    setNotice,
    dirty,
    setDirty,
    mapping,
    setMapping,
    loading,
    deleting,
    discard,
    selectVersion,
    saved,
    remove,
    working,
    setWorking,
  };
}

function TemplateActions({ page }: { page: TemplatePageState }) {
  const {
    template,
    versions,
    loading,
    deleting,
    mapping,
    setMapping,
    setDirty,
    discard,
    selectVersion,
    remove,
    working,
  } = page;
  if (!template) return null;
  return (
    <>
      <Field label="Version">
        <select
          className="select"
          disabled={loading || deleting || working}
          onChange={(event) => void selectVersion(Number(event.target.value))}
          value={template.version}
        >
          {versions.map((version) => (
            <option key={version.version} value={version.version}>
              v{version.version}
              {version.version === template.currentVersion ? " · Latest" : ""} ·{" "}
              {formatDate(version.createdAt.slice(0, 10))}
            </option>
          ))}
        </select>
      </Field>
      <Button
        disabled={loading || deleting || mapping || working}
        onClick={async () => {
          if (await discard()) {
            setDirty(false);
            setMapping(true);
          }
        }}
        variant="primary"
      >
        Use this version
      </Button>
      <Button
        busy={deleting}
        disabled={loading || working}
        icon="trash"
        onClick={() => void remove()}
        variant="ghost"
      >
        Delete template
      </Button>
    </>
  );
}

function confirmTemplateDeletion() {
  return confirmDialog({
    confirmLabel: "Delete template",
    message: "Contracts already created from it will stay available.",
    title: "Delete this template and all of its versions?",
    tone: "danger",
  });
}

function versionSummary(template: ContractTemplate): TemplateVersion {
  return {
    createdAt: template.createdAt,
    createdByName: template.createdByName,
    name: template.name,
    version: template.version,
  };
}
