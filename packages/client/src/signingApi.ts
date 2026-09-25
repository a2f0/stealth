import { apiUrl } from "./config";
import type {
  ContractStatus,
  FieldBox,
  FieldType,
  RecipientStatus,
} from "./contractsApi";

export interface SigningField extends FieldBox {
  id: string;
  label: string | null;
  required: boolean;
  type: FieldType;
}

export interface SigningView {
  canSign: boolean;
  contract: {
    completedAt: string | null;
    documentFilename: string;
    dueDate: string | null;
    message: string;
    organizationName: string;
    pageCount: number;
    senderName: string | null;
    status: ContractStatus;
    title: string;
  };
  fields: SigningField[];
  recipient: {
    email: string;
    name: string;
    signedAt: string | null;
    status: RecipientStatus;
  };
}

interface Signature {
  consent: boolean;
  initials?: string | undefined;
  signature?: string | undefined;
  values: Record<string, string>;
}

// Signers have no account: the token in the path is the only credential, so
// requests carry no cookies.
export function getSigning(token: string) {
  return request<SigningView>(path(token));
}

export function signContract(token: string, signature: Signature) {
  return request<{ completed: boolean; status: "signed" }>(
    `${path(token)}/sign`,
    { body: JSON.stringify(signature), method: "POST" },
  );
}

export function declineContract(token: string, reason: string) {
  return request<{ status: "declined" }>(`${path(token)}/decline`, {
    body: JSON.stringify({ reason }),
    method: "POST",
  });
}

export function signingDocumentUrl(token: string) {
  return `${apiUrl}/api/signing${path(token)}/document`;
}

export function signingFinalUrl(token: string) {
  return `${apiUrl}/api/signing${path(token)}/final`;
}

function path(token: string) {
  return `/${encodeURIComponent(token)}`;
}

async function request<T>(route: string, init?: RequestInit) {
  const requestInit: RequestInit = { ...init, credentials: "omit" };
  if (init?.body) requestInit.headers = { "Content-Type": "application/json" };
  const response = await fetch(`${apiUrl}/api/signing${route}`, requestInit);
  if (response.ok) return response.json() as Promise<T>;
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  throw new Error(
    body?.error ?? `Request failed with status ${response.status}.`,
  );
}
