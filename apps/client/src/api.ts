import { apiUrl } from "./config";

export interface StoredObject {
  id: string;
  objectKey: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface InboundEmailSummary {
  attachmentCount: number;
  from: string;
  id: string;
  rawSize: number;
  receivedAt: string;
  subject: string | null;
  to: string;
}

export interface InboundEmailAttachment {
  contentType: string;
  filename: string;
  id: string;
  size: number;
}

export interface InboundEmailDetail extends InboundEmailSummary {
  attachments: InboundEmailAttachment[];
  html: string | null;
  text: string | null;
}

interface OrganizationInbox {
  address: string;
  emails: InboundEmailSummary[];
}

export interface AdminOrganization {
  createdAt: number | string;
  deletedByEmail: string | null;
  deletedByName: string | null;
  deletedByUserId: string | null;
  deletedAt: number | string | null;
  id: string;
  memberCount: number;
  name: string;
  ownerEmail: string | null;
  ownerName: string | null;
  slug: string;
}

export async function listAdminOrganizations() {
  const response = await fetch(`${apiUrl}/api/admin/organizations`, {
    credentials: "include",
  });
  const body = await parseResponse<{ organizations: AdminOrganization[] }>(
    response,
  );
  return body.organizations;
}

export async function markAdminOrganizationForDeletion(id: string) {
  const response = await fetch(
    `${apiUrl}/api/admin/organizations/${encodeURIComponent(id)}`,
    {
      credentials: "include",
      method: "DELETE",
    },
  );
  return parseResponse<{
    deletedAt: string;
    deletedByEmail: string;
    deletedByName: string;
    deletedByUserId: string;
    organizationId: string;
  }>(response);
}

export async function restoreAdminOrganization(id: string) {
  const response = await fetch(
    `${apiUrl}/api/admin/organizations/${encodeURIComponent(id)}/restore`,
    {
      credentials: "include",
      method: "POST",
    },
  );
  return parseResponse<{ organizationId: string }>(response);
}

export async function listInboundEmails() {
  const response = await fetch(`${apiUrl}/api/inbox`, {
    credentials: "include",
  });
  return parseResponse<OrganizationInbox>(response);
}

export async function getInboundEmail(id: string) {
  const response = await fetch(
    `${apiUrl}/api/inbox/${encodeURIComponent(id)}`,
    {
      credentials: "include",
    },
  );
  const body = await parseResponse<{ email: InboundEmailDetail }>(response);
  return body.email;
}

export function inboundAttachmentUrl(emailId: string, attachmentId: string) {
  return `${apiUrl}/api/inbox/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

export async function listObjects() {
  const response = await fetch(`${apiUrl}/api/objects`, {
    credentials: "include",
  });
  const body = await parseResponse<{ objects: StoredObject[] }>(response);
  return body.objects;
}

export async function uploadObject(file: File) {
  const form = new FormData();
  form.set("file", file);
  const response = await fetch(`${apiUrl}/api/objects`, {
    method: "POST",
    body: form,
    credentials: "include",
  });
  return parseResponse<{ object: StoredObject }>(response);
}

export async function deleteObject(id: string) {
  const response = await fetch(`${apiUrl}/api/objects/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!response.ok) {
    await parseResponse(response);
  }
}

export function objectDownloadUrl(id: string) {
  return `${apiUrl}/api/objects/${id}`;
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok) {
    return response.json() as Promise<T>;
  }

  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  throw new Error(
    body?.error ?? `Request failed with status ${response.status}.`,
  );
}
