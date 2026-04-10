import type { TenantInvite, TenantMember } from "./dashboardTypes";

export function authHeaders(accessToken: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
}

export async function readJson(response: Response) {
  return response.json().catch(() => null);
}

export async function fetchTenantMembers(
  accessToken: string,
  tenantId: string,
): Promise<TenantMember[]> {
  const response = await fetch(`/tenant/${tenantId}/members`, {
    method: "GET",
    headers: authHeaders(accessToken),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const message =
      typeof payload?.message === "string"
        ? payload.message
        : "Failed to load users";
    throw new Error(message);
  }
  return Array.isArray(payload?.members) ? payload.members : [];
}

export async function createTenantInvite(
  accessToken: string,
  tenantId: string,
  input: { roleKey: string; emailOptional?: string | null },
): Promise<TenantInvite> {
  const response = await fetch(`/tenant/${tenantId}/invites`, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify(input),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const message =
      typeof payload?.message === "string"
        ? payload.message
        : "Failed to create invite";
    throw new Error(message);
  }
  return payload as TenantInvite;
}
