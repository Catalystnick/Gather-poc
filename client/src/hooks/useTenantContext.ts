import { useCallback, useEffect, useState } from "react";

export type TenantAccessConfig = {
  guestZoneEnforced: boolean;
  guestCanChat: boolean;
  guestCanTag: boolean;
  guestCanTeleport: boolean;
  memberCanTag: boolean;
  memberCanTeleport: boolean;
  updatedBy?: string | null;
  updatedAt?: string | null;
};

export type TenantContextState = {
  userId: string;
  mainPlazaWorldId: string | null;
  homeTenantId: string | null;
  role: string | null;
  roleKey: string | null;
  permissions: string[];
  homeInteriorWorldId: string | null;
  hasMembership: boolean;
  tenant: {
    id: string;
    name: string;
    slug: string;
    accessPolicy: "public" | "private";
    accessConfig: TenantAccessConfig | null;
  } | null;
};

async function readJson(response: Response) {
  return response.json().catch(() => null);
}

function authHeaders(accessToken: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
}

async function fetchTenantMe(accessToken: string): Promise<TenantContextState> {
  const response = await fetch("/tenant/me", {
    method: "GET",
    headers: authHeaders(accessToken),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const message = typeof payload?.message === "string" ? payload.message : "Failed to load tenant context";
    throw new Error(message);
  }
  return payload as TenantContextState;
}

type BootstrapInput =
  | { mode: "create_tenant"; tenantName: string }
  | { mode: "join_invite"; inviteToken: string };

async function postTenantBootstrap(accessToken: string, body: BootstrapInput): Promise<TenantContextState> {
  const response = await fetch("/tenant/bootstrap", {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const message = typeof payload?.message === "string" ? payload.message : "Tenant bootstrap failed";
    throw new Error(message);
  }
  return payload as TenantContextState;
}

async function patchTenantSettings(
  accessToken: string,
  tenantId: string,
  accessPolicy: "public" | "private",
  tenantAccessConfig: TenantAccessConfig,
) {
  const response = await fetch(`/tenant/${tenantId}/settings`, {
    method: "PATCH",
    headers: authHeaders(accessToken),
    body: JSON.stringify({
      accessPolicy,
      tenantAccessConfig: {
        guestZoneEnforced: tenantAccessConfig.guestZoneEnforced,
        guestCanChat: tenantAccessConfig.guestCanChat,
        guestCanTag: tenantAccessConfig.guestCanTag,
        guestCanTeleport: tenantAccessConfig.guestCanTeleport,
        memberCanTag: tenantAccessConfig.memberCanTag,
        memberCanTeleport: tenantAccessConfig.memberCanTeleport,
      },
    }),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const message = typeof payload?.message === "string" ? payload.message : "Failed to update tenant settings";
    throw new Error(message);
  }
}

export function useTenantContext(accessToken: string) {
  const [context, setContext] = useState<TenantContextState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!accessToken) return null;
    setIsLoading(true);
    setError(null);
    try {
      const nextContext = await fetchTenantMe(accessToken);
      setContext(nextContext);
      return nextContext;
    } catch (err) {
      setContext(null);
      setError(err instanceof Error ? err.message : "Failed to load tenant context");
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) {
      setContext(null);
      setError(null);
      setIsLoading(false);
      return;
    }
    void refresh();
  }, [accessToken, refresh]);

  const bootstrapCreateTenant = useCallback(async (tenantName: string) => {
    const name = tenantName.trim();
    if (!name) throw new Error("Tenant name is required");
    if (!accessToken) throw new Error("Missing access token");
    const nextContext = await postTenantBootstrap(accessToken, {
      mode: "create_tenant",
      tenantName: name,
    });
    setContext(nextContext);
    setError(null);
    return nextContext;
  }, [accessToken]);

  const bootstrapJoinInvite = useCallback(async (inviteToken: string) => {
    const token = inviteToken.trim();
    if (!token) throw new Error("Invite token is required");
    if (!accessToken) throw new Error("Missing access token");
    const nextContext = await postTenantBootstrap(accessToken, {
      mode: "join_invite",
      inviteToken: token,
    });
    setContext(nextContext);
    setError(null);
    return nextContext;
  }, [accessToken]);

  const saveTenantSettings = useCallback(async (
    tenantId: string,
    accessPolicy: "public" | "private",
    tenantAccessConfig: TenantAccessConfig,
  ) => {
    if (!accessToken) throw new Error("Missing access token");
    await patchTenantSettings(accessToken, tenantId, accessPolicy, tenantAccessConfig);
    await refresh();
  }, [accessToken, refresh]);

  return {
    context,
    isLoading,
    error,
    refresh,
    bootstrapCreateTenant,
    bootstrapJoinInvite,
    saveTenantSettings,
  };
}
