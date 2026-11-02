import type { Env } from "./types";

export async function supabaseRequest<T>(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase server credentials are not configured");
  const response = await fetch(new URL(`/rest/v1/${path}`, env.SUPABASE_URL), {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...init.headers
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase request failed (${response.status}): ${body.slice(0, 500)}`);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}
