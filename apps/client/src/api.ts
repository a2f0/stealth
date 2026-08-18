import { apiUrl } from "./config";

export interface StoredObject {
  id: string;
  objectKey: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
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
