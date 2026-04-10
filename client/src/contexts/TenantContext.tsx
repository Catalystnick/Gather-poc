import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { signOutIfUnauthorizedStatus } from "../lib/unauthorizedSignOut";

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

export type TenantInviteAccessConfig = {
  allowlistDomains: string[];
  allowlistEmails: string[];
  requirePasswordForUnlisted: boolean;
  hasPassword: boolean;
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
    inviteAccessConfig: TenantInviteAccessConfig | null;
  } | null;
};

type TenantApiError = Error & {
  code?: string;
  details?: unknown;
  status?: number;
};

type TenantContextValue = {
  context: TenantContextState | null;
  isLoading: boolean;
  error: string | null;
  refresh: (options?: { blocking?: boolean }) => Promise<TenantContextState | null>;
  createTenantDuringOnboarding: (tenantName: string) => Promise<TenantContextState>;
  joinTenantFromInvite: (inviteToken: string, invitePassword?: string) => Promise<TenantContextState>;
  saveTenantSettings: (
    tenantId: string,
    accessPolicy: "public" | "private",
    tenantAccessConfig: TenantAccessConfig,
  ) => Promise<void>;
};

const TenantContext = createContext<TenantContextValue | null>(null);

async function readJson(response: Response) {
  // Best-effort JSON parsing keeps API error handling resilient to empty/non-JSON bodies.
  return response.json().catch(() => null);
}

function authHeaders(accessToken: string) {
  // Tenant APIs are server-protected and always require bearer auth.
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
}

async function fetchTenantMe(accessToken: string): Promise<TenantContextState> {
  // Single source of truth for current tenant membership/permissions.
  const response = await fetch("/tenant/me", {
    method: "GET",
    headers: authHeaders(accessToken),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    await signOutIfUnauthorizedStatus(response.status);
    const message = typeof payload?.message === "string" ? payload.message : "Failed to load tenant context";
    const error = new Error(message) as TenantApiError;
    error.status = response.status;
    throw error;
  }
  return payload as TenantContextState;
}

type TenantOnboardingInput =
  | { mode: "create_tenant"; tenantName: string }
  | { mode: "join_invite"; inviteToken: string; invitePassword?: string };

function toTenantApiError(payload: any, fallbackMessage: string): TenantApiError {
  const message =
    typeof payload?.message === "string" ? payload.message : fallbackMessage;
  const error = new Error(message) as TenantApiError;
  if (typeof payload?.error === "string") error.code = payload.error;
  if (payload?.details !== undefined) error.details = payload.details;
  return error;
}

async function postTenantOnboarding(accessToken: string, body: TenantOnboardingInput): Promise<TenantContextState> {
  // Tenant onboarding is the only entry path for users without membership.
  const response = await fetch("/tenant/onboarding", {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    await signOutIfUnauthorizedStatus(response.status);
    const error = toTenantApiError(payload, "Tenant onboarding failed");
    error.status = response.status;
    throw error;
  }
  return payload as TenantContextState;
}

async function patchTenantSettings(accessToken: string, tenantId: string, accessPolicy: "public" | "private", tenantAccessConfig: TenantAccessConfig) {
  // Keep request payload aligned with server's DTO field names.
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
    await signOutIfUnauthorizedStatus(response.status);
    const message = typeof payload?.message === "string" ? payload.message : "Failed to update tenant settings";
    const error = new Error(message) as TenantApiError;
    error.status = response.status;
    throw error;
  }
}

export function TenantContextProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const accessToken = session?.access_token ?? "";
  const [context, setContext] = useState<TenantContextState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);

  const refresh = useCallback(
    async (options?: { blocking?: boolean }) => {
      // Blocking mode is used only during first load to avoid scene teardown on token refresh.
      if (!accessToken) return null;
      const shouldBlock = !!options?.blocking;
      if (shouldBlock) setIsLoading(true);
      setError(null);
      try {
        const nextContext = await fetchTenantMe(accessToken);
        setContext(nextContext);
        setHasLoaded(true);
        return nextContext;
      } catch (err) {
        setContext(null);
        setError(err instanceof Error ? err.message : "Failed to load tenant context");
        setHasLoaded(true);
        return null;
      } finally {
        if (shouldBlock) setIsLoading(false);
      }
    },
    [accessToken],
  );

  useEffect(() => {
    if (!accessToken) {
      setContext(null);
      setError(null);
      setIsLoading(false);
      setHasLoaded(false);
      return;
    }
    // After initial load we refresh in background when tokens rotate.
    const shouldBlock = !hasLoaded;
    void refresh({ blocking: shouldBlock });
  }, [accessToken, hasLoaded, refresh]);

  const createTenantDuringOnboarding = useCallback(
    async (tenantName: string) => {
      const name = tenantName.trim();
      if (!name) throw new Error("Tenant name is required");
      if (!accessToken) throw new Error("Missing access token");
      const nextContext = await postTenantOnboarding(accessToken, {
        mode: "create_tenant",
        tenantName: name,
      });
      setContext(nextContext);
      setError(null);
      return nextContext;
    },
    [accessToken],
  );

  const joinTenantFromInvite = useCallback(
    async (inviteToken: string, invitePassword?: string) => {
      const token = inviteToken.trim();
      if (!token) throw new Error("Invite token is required");
      if (!accessToken) throw new Error("Missing access token");
      const nextContext = await postTenantOnboarding(accessToken, {
        mode: "join_invite",
        inviteToken: token,
        ...(invitePassword ? { invitePassword } : {}),
      });
      setContext(nextContext);
      setError(null);
      return nextContext;
    },
    [accessToken],
  );

  const saveTenantSettings = useCallback(
    async (tenantId: string, accessPolicy: "public" | "private", tenantAccessConfig: TenantAccessConfig) => {
      if (!accessToken) throw new Error("Missing access token");
      await patchTenantSettings(accessToken, tenantId, accessPolicy, tenantAccessConfig);
      // Refresh immediately so role-gated UI reflects saved server state.
      await refresh();
    },
    [accessToken, refresh],
  );

  const value = useMemo<TenantContextValue>(() => ({
    context,
    isLoading,
    error,
    refresh,
    createTenantDuringOnboarding,
    joinTenantFromInvite,
    saveTenantSettings,
  }), [
    context,
    isLoading,
    error,
    refresh,
    createTenantDuringOnboarding,
    joinTenantFromInvite,
    saveTenantSettings,
  ]);

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export function useTenantContext(): TenantContextValue {
  const context = useContext(TenantContext);
  if (!context) {
    throw new Error("useTenantContext must be used inside <TenantContextProvider>");
  }
  return context;
}
