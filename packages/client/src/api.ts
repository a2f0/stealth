import { fetchApi } from "./apiVersion";
import { apiUrl } from "./config";

export interface StoredObject {
  folderId: string | null;
  id: string;
  objectKey: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface InboundEmailSummary {
  attachmentCount: number;
  deletedAt: string | null;
  deletedByEmail: string | null;
  deletedByName: string | null;
  deletedByUserId: string | null;
  from: string;
  id: string;
  rawSize: number;
  receivedAt: string;
  subject: string | null;
  to: string;
}

export type InboxFolder = "inbox" | "trash";

export interface InboundEmailAttachment {
  contentType: string;
  filename: string;
  id: string;
  size: number;
}

export type InboundEmailLink =
  | {
      equipment: {
        make: string;
        model: string;
        serialNumber: string | null;
        type: string;
      };
      id: string;
      targetId: string;
      targetType: "equipment";
    }
  | {
      folder: { name: string };
      id: string;
      targetId: string;
      targetType: "library_folder";
    }
  | {
      id: string;
      targetId: string;
      targetType: "finance_transaction";
      transaction: {
        amount: number;
        currencyCode: string | null;
        date: string;
        merchantName: string | null;
        name: string;
      };
    };

export type InboundEmailLinkTarget = Pick<
  InboundEmailLink,
  "targetId" | "targetType"
>;

export interface InboundEmailDetail extends InboundEmailSummary {
  attachments: InboundEmailAttachment[];
  html: string | null;
  links: InboundEmailLink[];
  text: string | null;
}

/** An email linked to a folder or transaction, as the target lists it. */
export interface LinkedEmail {
  attachmentCount: number;
  from: string;
  id: string;
  linkId: string;
  receivedAt: string;
  subject: string | null;
}

export interface LibraryFolder {
  createdAt: string;
  emailCount: number;
  fileCount: number;
  id: string;
  name: string;
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
  const response = await fetchApi(`${apiUrl}/api/admin/organizations`, {
    credentials: "include",
  });
  const body = await parseResponse<{ organizations: AdminOrganization[] }>(
    response,
  );
  return body.organizations;
}

export async function markAdminOrganizationForDeletion(id: string) {
  const response = await fetchApi(
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
  const response = await fetchApi(
    `${apiUrl}/api/admin/organizations/${encodeURIComponent(id)}/restore`,
    {
      credentials: "include",
      method: "POST",
    },
  );
  return parseResponse<{ organizationId: string }>(response);
}

export async function listInboundEmails(folder: InboxFolder = "inbox") {
  const response = await fetchApi(`${apiUrl}/api/inbox${folderQuery(folder)}`, {
    credentials: "include",
  });
  return parseResponse<OrganizationInbox>(response);
}

export async function getInboundEmail(
  id: string,
  folder: InboxFolder = "inbox",
) {
  const response = await fetchApi(
    `${apiUrl}/api/inbox/${encodeURIComponent(id)}${folderQuery(folder)}`,
    {
      credentials: "include",
    },
  );
  const body = await parseResponse<{ email: InboundEmailDetail }>(response);
  return body.email;
}

export function inboundAttachmentUrl(
  emailId: string,
  attachmentId: string,
  folder: InboxFolder = "inbox",
) {
  return `${apiUrl}/api/inbox/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}${folderQuery(folder)}`;
}

export async function deleteInboundEmail(id: string) {
  const response = await fetchApi(
    `${apiUrl}/api/inbox/${encodeURIComponent(id)}`,
    { credentials: "include", method: "DELETE" },
  );
  return parseResponse<{
    deletedAt: string;
    deletedByUserId: string;
    emailId: string;
  }>(response);
}

export async function restoreInboundEmail(id: string) {
  const response = await fetchApi(
    `${apiUrl}/api/inbox/${encodeURIComponent(id)}/restore`,
    { credentials: "include", method: "POST" },
  );
  return parseResponse<{ emailId: string }>(response);
}

export async function linkInboundEmail(
  emailId: string,
  target: InboundEmailLinkTarget,
) {
  const response = await fetchApi(
    `${apiUrl}/api/inbox/${encodeURIComponent(emailId)}/links`,
    {
      body: JSON.stringify(target),
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  const body = await parseResponse<{ link: InboundEmailLink }>(response);
  return body.link;
}

export async function unlinkInboundEmail(emailId: string, linkId: string) {
  const response = await fetchApi(
    `${apiUrl}/api/inbox/${encodeURIComponent(emailId)}/links/${encodeURIComponent(linkId)}`,
    { credentials: "include", method: "DELETE" },
  );
  if (!response.ok) {
    await parseResponse(response);
  }
}

function folderQuery(folder: InboxFolder) {
  return folder === "trash" ? "?folder=trash" : "";
}

/** Lists one folder's files, or the files at the library root. */
export async function listObjects(folderId?: string) {
  const query = folderId ? `?folder=${encodeURIComponent(folderId)}` : "";
  const response = await fetchApi(`${apiUrl}/api/objects${query}`, {
    credentials: "include",
  });
  const body = await parseResponse<{ objects: StoredObject[] }>(response);
  return body.objects;
}

export async function uploadObject(file: File, folderId?: string) {
  const form = new FormData();
  form.set("file", file);
  if (folderId) form.set("folderId", folderId);
  const response = await fetchApi(`${apiUrl}/api/objects`, {
    method: "POST",
    body: form,
    credentials: "include",
  });
  return parseResponse<{ object: StoredObject }>(response);
}

export async function deleteObject(id: string) {
  const response = await fetchApi(`${apiUrl}/api/objects/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!response.ok) {
    await parseResponse(response);
  }
}

/** Moves a file into a folder, or back to the library root with null. */
export async function moveObject(id: string, folderId: string | null) {
  const response = await fetchApi(
    `${apiUrl}/api/objects/${encodeURIComponent(id)}`,
    {
      body: JSON.stringify({ folderId }),
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    },
  );
  const body = await parseResponse<{ object: StoredObject }>(response);
  return body.object;
}

export function objectDownloadUrl(id: string) {
  return `${apiUrl}/api/objects/${id}`;
}

export async function listLibraryFolders() {
  const response = await fetchApi(`${apiUrl}/api/library/folders`, {
    credentials: "include",
  });
  const body = await parseResponse<{ folders: LibraryFolder[] }>(response);
  return body.folders;
}

export async function getLibraryFolder(id: string) {
  const response = await fetchApi(
    `${apiUrl}/api/library/folders/${encodeURIComponent(id)}`,
    { credentials: "include" },
  );
  return parseResponse<{ emails: LinkedEmail[]; folder: LibraryFolder }>(
    response,
  );
}

export async function createLibraryFolder(name: string) {
  const response = await fetchApi(`${apiUrl}/api/library/folders`, {
    body: JSON.stringify({ name }),
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const body = await parseResponse<{ folder: LibraryFolder }>(response);
  return body.folder;
}

export async function renameLibraryFolder(id: string, name: string) {
  const response = await fetchApi(
    `${apiUrl}/api/library/folders/${encodeURIComponent(id)}`,
    {
      body: JSON.stringify({ name }),
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    },
  );
  await parseResponse(response);
}

export async function deleteLibraryFolder(id: string) {
  const response = await fetchApi(
    `${apiUrl}/api/library/folders/${encodeURIComponent(id)}`,
    { credentials: "include", method: "DELETE" },
  );
  if (!response.ok) {
    await parseResponse(response);
  }
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
