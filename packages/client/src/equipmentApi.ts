import type { LinkedEmail } from "./api";
import { fetchApi } from "./apiVersion";
import { apiUrl } from "./config";

export interface EquipmentMember {
  email: string;
  id: string;
  name: string;
}

export interface EquipmentItem {
  assignee: EquipmentMember | null;
  createdAt: string;
  /** Inbox emails outside Trash linked to this item. */
  emailCount: number;
  id: string;
  make: string;
  model: string;
  purchaseDate: string | null;
  serialNumber: string | null;
  type: string;
  updatedAt: string;
}

export interface EquipmentInput {
  assigneeId: string | null;
  make: string;
  model: string;
  purchaseDate: string | null;
  serialNumber: string | null;
  type: string;
}

interface EquipmentContext {
  canManage: boolean;
  members: EquipmentMember[];
  /** The types new equipment can have, in display order. */
  types: string[];
}

export interface EquipmentListing extends EquipmentContext {
  equipment: EquipmentItem[];
}

export interface EquipmentDetail extends EquipmentContext {
  emails: LinkedEmail[];
  equipment: EquipmentItem;
}

export function listEquipment() {
  return request<EquipmentListing>("");
}

export function getEquipment(id: string) {
  return request<EquipmentDetail>(`/${encodeURIComponent(id)}`);
}

export async function createEquipment(input: EquipmentInput) {
  const body = await request<{ equipment: EquipmentItem }>("", {
    body: JSON.stringify(input),
    method: "POST",
  });
  return body.equipment;
}

/** Updates the given fields; `assigneeId: null` unassigns the item. */
export async function updateEquipment(
  id: string,
  changes: Partial<EquipmentInput>,
) {
  const body = await request<{ equipment: EquipmentItem }>(
    `/${encodeURIComponent(id)}`,
    { body: JSON.stringify(changes), method: "PATCH" },
  );
  return body.equipment;
}

export async function deleteEquipment(id: string) {
  const response = await fetchApi(
    `${apiUrl}/api/equipment/${encodeURIComponent(id)}`,
    { credentials: "include", method: "DELETE" },
  );
  if (!response.ok) throw await parseError(response);
}

async function request<T>(path: string, init?: RequestInit) {
  const requestInit: RequestInit = { ...init, credentials: "include" };
  if (init?.body) requestInit.headers = { "Content-Type": "application/json" };
  const response = await fetchApi(
    `${apiUrl}/api/equipment${path}`,
    requestInit,
  );
  if (response.ok) return response.json() as Promise<T>;
  throw await parseError(response);
}

async function parseError(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return new Error(
    body?.error ?? `Request failed with status ${response.status}.`,
  );
}
