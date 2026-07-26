export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

let mutationToken: string | null = null;

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const value = await response.json();
  if (!response.ok) throw new ApiError(value.error ?? `Request failed: ${response.status}`, response.status);
  return value as T;
}

export async function post<T>(url: string, value: unknown = {}): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const currentMutationToken = await localMutationToken();
    try {
      return await api<T>(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-attention-mutation-token": currentMutationToken,
        },
        body: JSON.stringify(value),
      });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 403 || attempt > 0) throw error;
      mutationToken = null;
    }
  }
  throw new Error("Local mutation authorization failed.");
}

export async function localRead<T>(url: string, init: RequestInit = {}): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await localMutationToken(init.signal);
    const headers = new Headers(init.headers);
    headers.set("x-attention-read-token", token);
    try {
      return await api<T>(url, { ...init, headers });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 403 || attempt > 0) throw error;
      mutationToken = null;
    }
  }
  throw new Error("Local read authorization failed.");
}

async function localMutationToken(signal?: AbortSignal | null): Promise<string> {
  if (mutationToken) return mutationToken;
  const session = await api<{ mutationToken: string }>("/api/session", { signal });
  mutationToken = session.mutationToken;
  return mutationToken;
}
