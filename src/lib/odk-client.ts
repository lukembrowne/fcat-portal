/**
 * ODK Central API Client — Parameterized for multi-project/multi-form use.
 *
 * Shared session token cache. Pagination for >250 records. 401 retry.
 */

import "server-only";

const ODK_CENTRAL_URL = process.env.ODK_CENTRAL_URL!;
const ODK_CENTRAL_EMAIL = process.env.ODK_CENTRAL_EMAIL!;
const ODK_CENTRAL_PASSWORD = process.env.ODK_CENTRAL_PASSWORD!;

const PAGE_SIZE = 250;

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getSessionToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  const res = await fetch(`${ODK_CENTRAL_URL}/v1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: ODK_CENTRAL_EMAIL,
      password: ODK_CENTRAL_PASSWORD,
    }),
  });

  if (!res.ok) {
    throw new Error(`ODK auth failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  cachedToken = {
    token: data.token,
    expiresAt: Date.now() + 55 * 60 * 1000, // refresh 5 min before 1hr expiry
  };
  return data.token;
}

function invalidateToken() {
  cachedToken = null;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getSessionToken();
  return { Authorization: `Bearer ${token}` };
}

/**
 * Fetch with 401 retry — re-authenticates once on token expiry.
 */
async function odkFetch(
  url: string,
  options?: RequestInit
): Promise<Response> {
  const headers = await authHeaders();
  const res = await fetch(url, { ...options, headers: { ...headers, ...options?.headers } });

  if (res.status === 401) {
    invalidateToken();
    const freshHeaders = await authHeaders();
    return fetch(url, { ...options, headers: { ...freshHeaders, ...options?.headers } });
  }

  return res;
}

/**
 * Fetch all submissions from an ODK form, paginating through >250 results.
 */
export async function fetchSubmissions<T = Record<string, unknown>>(
  projectId: string,
  formId: string,
  options?: { since?: string; revalidate?: number }
): Promise<T[]> {
  const baseUrl = `${ODK_CENTRAL_URL}/v1/projects/${projectId}/forms/${formId}.svc/Submissions`;
  const all: T[] = [];
  let skip = 0;

  while (true) {
    const params = new URLSearchParams({
      $top: String(PAGE_SIZE),
      $skip: String(skip),
    });
    if (options?.since) {
      params.set("$filter", `__system/submissionDate gt ${options.since}`);
    }

    const url = `${baseUrl}?${params}`;
    const res = await odkFetch(url, {
      next: { revalidate: options?.revalidate ?? 300 },
    } as RequestInit);

    if (!res.ok) {
      throw new Error(`ODK fetch failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const values = (data.value ?? []) as T[];
    all.push(...values);

    if (values.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }

  return all;
}

/**
 * Fetch entities from an ODK entity list (dataset) via OData.
 */
export async function fetchEntities<T = Record<string, unknown>>(
  projectId: string,
  datasetName: string,
  options?: { revalidate?: number }
): Promise<T[]> {
  const url = `${ODK_CENTRAL_URL}/v1/projects/${projectId}/datasets/${datasetName}.svc/Entities`;
  const res = await odkFetch(url, {
    next: { revalidate: options?.revalidate ?? 300 },
  } as RequestInit);

  if (!res.ok) {
    throw new Error(`ODK entities fetch failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const entities = (data.value ?? []) as Record<string, unknown>[];

  // Flatten: extract __id as uuid, keep label, copy non-system properties
  return entities.map((entity) => {
    const flat: Record<string, unknown> = {
      uuid: entity.__id ?? "",
      label: entity.label ?? "",
    };
    for (const [key, value] of Object.entries(entity)) {
      if (!key.startsWith("__") && key !== "label") {
        flat[key] = value;
      }
    }
    return flat as T;
  });
}

/**
 * Fetch an attachment (photo) from an ODK submission.
 */
export async function fetchAttachment(
  projectId: string,
  formId: string,
  instanceId: string,
  filename: string
): Promise<Response> {
  const url = `${ODK_CENTRAL_URL}/v1/projects/${projectId}/forms/${formId}/submissions/${instanceId}/attachments/${filename}`;
  const res = await odkFetch(url);

  if (!res.ok) {
    throw new Error(`ODK attachment fetch failed: ${res.status}`);
  }
  return res;
}

/**
 * Fetch data from a repeat group (e.g., Submissions.fotos).
 */
export async function fetchRepeatData<T = Record<string, unknown>>(
  projectId: string,
  formId: string,
  repeatName: string,
  options?: { revalidate?: number }
): Promise<T[]> {
  const url = `${ODK_CENTRAL_URL}/v1/projects/${projectId}/forms/${formId}.svc/Submissions.${repeatName}`;
  const res = await odkFetch(url, {
    next: { revalidate: options?.revalidate ?? 300 },
  } as RequestInit);

  if (!res.ok) {
    throw new Error(`ODK repeat fetch failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return (data.value ?? []) as T[];
}

/**
 * Parse WKT POINT string to lat/lng.
 * Input: "POINT (lon lat elevation)" or "POINT (lon lat)"
 */
export function parseWktPoint(wkt: string | null | undefined): { lat: number; lng: number } | null {
  if (!wkt || typeof wkt !== "string") return null;
  const match = wkt.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)/i);
  if (!match) return null;
  return { lat: parseFloat(match[2]), lng: parseFloat(match[1]) };
}
