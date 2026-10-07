import { useSyncExternalStore } from "react";

// The API names its version in this header on every response.
const apiVersionHeader = "API-Version";

let apiVersion: string | null = null;
const listeners = new Set<() => void>();

/**
 * `fetch` to the API, keeping the version its response names, whatever its
 * status. A response that names none, such as one from a proxy in front of the
 * API, leaves the last version known. Every API call goes through here, so a
 * deploy while the app is open shows up with the next response.
 */
export async function fetchApi(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init);
  const version = response.headers.get(apiVersionHeader);
  if (version !== null && version !== apiVersion) {
    apiVersion = version;
    for (const listener of listeners) listener();
  }
  return response;
}

/** The API version from the latest response that named one, or null. */
export function useApiVersion() {
  return useSyncExternalStore(subscribe, readApiVersion, readApiVersion);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readApiVersion() {
  return apiVersion;
}
