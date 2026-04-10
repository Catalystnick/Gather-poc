import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { useTenantContext } from "../../contexts/TenantContext";
import { clearPendingNextPath } from "../../utils/nextPath";
import { signOutIfUnauthorizedStatus } from "../../lib/unauthorizedSignOut";
import {
  authHeaders,
  createTenantInvite,
  fetchTenantMembers,
  readJson,
  updateInviteAccessSettings,
} from "./dashboardApi";
import {
  DashboardErrorView,
  DashboardLoadingView,
  InviteAutoJoinView,
  OnboardingView,
} from "./DashboardStateViews";
import { TenantDashboardView } from "./TenantDashboardView";
import type {
  InviteRoleKey,
  InviteType,
  OnboardingMode,
  TenantInvite,
  TenantMember,
} from "./dashboardTypes";

/** Tenant dashboard handles onboarding and non-game tenant administration flows. */
export default function DashboardRoute() {
  const { signOut, session } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const accessToken = session?.access_token ?? "";
  const tenantState = useTenantContext();

  const [onboardingMode, setOnboardingMode] =
    useState<OnboardingMode>("create");
  const [tenantNameInput, setTenantNameInput] = useState("");
  const [inviteTokenInput, setInviteTokenInput] = useState("");
  const [inviteJoinPasswordInput, setInviteJoinPasswordInput] = useState("");
  const [requiresInviteJoinPassword, setRequiresInviteJoinPassword] =
    useState(false);
  const [isSubmittingOnboarding, setIsSubmittingOnboarding] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);

  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isGrantingAdmin, setIsGrantingAdmin] = useState(false);
  const [adminToolStatus, setAdminToolStatus] = useState<string | null>(null);

  const [tenantMembers, setTenantMembers] = useState<TenantMember[]>([]);
  const [isDashboardLoading, setIsDashboardLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);

  const [inviteEmailInput, setInviteEmailInput] = useState("");
  const [inviteType, setInviteType] = useState<InviteType>("personalized");
  const [inviteRoleKey, setInviteRoleKey] = useState<InviteRoleKey>("member");
  const [isCreatingInvite, setIsCreatingInvite] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);
  const [createdInvite, setCreatedInvite] = useState<TenantInvite | null>(null);
  const [inviteAllowlistDomainsInput, setInviteAllowlistDomainsInput] =
    useState("");
  const [inviteAllowlistEmailsInput, setInviteAllowlistEmailsInput] =
    useState("");
  const [requirePasswordForUnlisted, setRequirePasswordForUnlisted] =
    useState(false);
  const [inviteJoinPolicyPasswordInput, setInviteJoinPolicyPasswordInput] =
    useState("");
  const [clearInviteJoinPassword, setClearInviteJoinPassword] = useState(false);
  const [hasInviteJoinPassword, setHasInviteJoinPassword] = useState(false);
  const [isSavingInviteAccess, setIsSavingInviteAccess] = useState(false);
  const [inviteAccessError, setInviteAccessError] = useState<string | null>(
    null,
  );
  const [inviteAccessStatus, setInviteAccessStatus] = useState<string | null>(
    null,
  );

  const autoJoinAttemptedTokenRef = useRef<string | null>(null);
  const tenantContext = tenantState.context;
  const effectiveInviteToken = searchParams.get("inviteToken")?.trim() ?? "";

  const currentRoleKey = tenantContext?.roleKey ?? null;
  const currentRequirePasswordForUnlisted =
    tenantContext?.tenant?.inviteAccessConfig?.requirePasswordForUnlisted ?? false;
  const permissionKeys = tenantContext?.permissions ?? [];
  const canManageMembers = permissionKeys.includes("tenant.members.manage");
  const canCreateInvites = permissionKeys.includes("tenant.invite.create");
  const canManageInviteAccess = permissionKeys.includes(
    "tenant.invite.access.manage",
  );
  const canManageInvitePassword = permissionKeys.includes(
    "tenant.invite.password.manage",
  );
  const canAccessAdminDashboard =
    canManageMembers || canCreateInvites || canManageInviteAccess;
  const isCurrentUserAdmin = canManageMembers;
  const activeTenantId = tenantContext?.tenant?.id ?? null;

  const inviteDescription =
    inviteType === "personalized"
      ? "Personalized invite: one-time use and bound to a specific email. You can choose member or admin role."
      : "Group invite: reusable until expiry, no email target, and all joiners are assigned member role.";

  function normalizeTextList(rawValue: string) {
    const parts = rawValue
      .split(/[\n,]+/g)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    return [...new Set(parts)];
  }

  function toJoinInviteError(error: unknown) {
    return error as Error & { code?: string };
  }

  function handleJoinInviteError(error: unknown) {
    const nextError = toJoinInviteError(error);
    const code = nextError?.code ?? "";
    const needsPassword =
      code === "invite_password_required" || code === "invite_password_invalid";
    setRequiresInviteJoinPassword(needsPassword);
    setOnboardingError(
      nextError instanceof Error
        ? nextError.message
        : "Failed to complete tenant setup",
    );
  }

  useEffect(() => {
    if (!effectiveInviteToken) return;
    setOnboardingMode("invite");
    setInviteTokenInput((current) =>
      current ? current : effectiveInviteToken,
    );
  }, [effectiveInviteToken]);

  useEffect(() => {
    const inviteAccess = tenantContext?.tenant?.inviteAccessConfig;
    if (!inviteAccess) return;
    setInviteAllowlistDomainsInput(inviteAccess.allowlistDomains.join("\n"));
    setInviteAllowlistEmailsInput(inviteAccess.allowlistEmails.join("\n"));
    setRequirePasswordForUnlisted(!!inviteAccess.requirePasswordForUnlisted);
    setHasInviteJoinPassword(!!inviteAccess.hasPassword);
    setClearInviteJoinPassword(false);
    setInviteJoinPolicyPasswordInput("");
  }, [tenantContext?.tenant?.inviteAccessConfig]);

  const loadDashboardData = useCallback(async () => {
    if (
      !accessToken ||
      !tenantContext?.hasMembership ||
      !canManageMembers ||
      !activeTenantId
    ) {
      return;
    }

    setIsDashboardLoading(true);
    setDashboardError(null);
    try {
      const members = await fetchTenantMembers(accessToken, activeTenantId);
      setTenantMembers(members);
    } catch (error) {
      setDashboardError(
        error instanceof Error
          ? error.message
          : "Failed to load dashboard data",
      );
      setTenantMembers([]);
    } finally {
      setIsDashboardLoading(false);
    }
  }, [
    accessToken,
    activeTenantId,
    canManageMembers,
    tenantContext?.hasMembership,
  ]);

  useEffect(() => {
    void loadDashboardData();
  }, [loadDashboardData]);

  const completeInviteAutoJoin = useCallback(async () => {
    if (!effectiveInviteToken) return;

    setIsSubmittingOnboarding(true);
    setOnboardingError(null);
    try {
      await tenantState.joinTenantFromInvite(
        effectiveInviteToken,
        inviteJoinPasswordInput,
      );
      await loadDashboardData();
      const nextSearchParams = new URLSearchParams(searchParams);
      nextSearchParams.delete("inviteToken");
      setSearchParams(nextSearchParams, { replace: true });
      clearPendingNextPath();
      setInviteTokenInput("");
      setInviteJoinPasswordInput("");
      setRequiresInviteJoinPassword(false);
      autoJoinAttemptedTokenRef.current = null;
    } catch (error) {
      handleJoinInviteError(error);
      autoJoinAttemptedTokenRef.current = null;
    } finally {
      setIsSubmittingOnboarding(false);
    }
  }, [
    effectiveInviteToken,
    inviteJoinPasswordInput,
    loadDashboardData,
    searchParams,
    setSearchParams,
    tenantState,
  ]);

  useEffect(() => {
    if (!effectiveInviteToken) {
      autoJoinAttemptedTokenRef.current = null;
      return;
    }
    if (!tenantContext || tenantContext.hasMembership) return;
    if (autoJoinAttemptedTokenRef.current === effectiveInviteToken) return;

    autoJoinAttemptedTokenRef.current = effectiveInviteToken;
    void completeInviteAutoJoin();
  }, [completeInviteAutoJoin, effectiveInviteToken, tenantContext]);

  const handleRetryInviteAutoJoin = useCallback(async () => {
    if (!effectiveInviteToken || isSubmittingOnboarding) return;
    await completeInviteAutoJoin();
  }, [completeInviteAutoJoin, effectiveInviteToken, isSubmittingOnboarding]);

  const handleSignOut = useCallback(async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await signOut();
      navigate("/login", { replace: true });
    } finally {
      setIsSigningOut(false);
    }
  }, [isSigningOut, navigate, signOut]);

  const handleOnboardingSubmit = useCallback(async () => {
    if (isSubmittingOnboarding) return;

    setIsSubmittingOnboarding(true);
    setOnboardingError(null);
    try {
      if (onboardingMode === "create") {
        await tenantState.createTenantDuringOnboarding(tenantNameInput);
      } else {
        await tenantState.joinTenantFromInvite(
          inviteTokenInput,
          inviteJoinPasswordInput,
        );
        const nextSearchParams = new URLSearchParams(searchParams);
        nextSearchParams.delete("inviteToken");
        setSearchParams(nextSearchParams, { replace: true });
      }

      await loadDashboardData();
      setTenantNameInput("");
      setInviteTokenInput("");
      setInviteJoinPasswordInput("");
      setRequiresInviteJoinPassword(false);
    } catch (error) {
      handleJoinInviteError(error);
    } finally {
      setIsSubmittingOnboarding(false);
    }
  }, [
    inviteJoinPasswordInput,
    inviteTokenInput,
    isSubmittingOnboarding,
    loadDashboardData,
    onboardingMode,
    searchParams,
    setSearchParams,
    tenantNameInput,
    tenantState,
  ]);

  const handleCopyInviteValue = useCallback(
    async (value: string, label: string) => {
      if (!value) return;
      try {
        if (!navigator.clipboard) throw new Error("clipboard unavailable");
        await navigator.clipboard.writeText(value);
        setInviteStatus(`${label} copied.`);
      } catch {
        setInviteStatus(`Failed to copy ${label.toLowerCase()}.`);
      }
    },
    [],
  );

  const handleCreateInvite = useCallback(async () => {
    if (!accessToken || !activeTenantId || isCreatingInvite) return;
    if (!canCreateInvites) {
      setInviteError("You do not have permission to create invites.");
      setInviteStatus(null);
      return;
    }

    const email = inviteEmailInput.trim();
    if (inviteType === "personalized" && !email) {
      setInviteError("Email is required for personalized invites.");
      setInviteStatus(null);
      return;
    }

    setIsCreatingInvite(true);
    setInviteError(null);
    setInviteStatus(null);
    try {
      const invite = await createTenantInvite(accessToken, activeTenantId, {
        roleKey: inviteType === "shared" ? "member" : inviteRoleKey,
        inviteEmail: inviteType === "personalized" ? email : null,
      });
      setCreatedInvite(invite);
      if (invite.delivery.sent) {
        setInviteStatus("Invite created and email sent.");
      } else if (invite.inviteType === "personalized") {
        setInviteStatus(
          "Invite created. Email was not sent, share token or link manually.",
        );
      } else {
        setInviteStatus("Invite created. Share token or link manually.");
      }
      setInviteEmailInput("");
    } catch (error) {
      setInviteError(
        error instanceof Error ? error.message : "Failed to create invite",
      );
      setCreatedInvite(null);
    } finally {
      setIsCreatingInvite(false);
    }
  }, [
    accessToken,
    activeTenantId,
    canCreateInvites,
    inviteEmailInput,
    inviteRoleKey,
    inviteType,
    isCreatingInvite,
  ]);

  const handleInviteTypeChange = useCallback((nextType: InviteType) => {
    setInviteType(nextType);
    setInviteError(null);
    setInviteStatus(null);
    if (nextType === "shared") {
      setInviteEmailInput("");
      setInviteRoleKey("member");
    }
  }, []);

  const handleSaveInviteAccessSettings = useCallback(async () => {
    if (!accessToken || !activeTenantId || isSavingInviteAccess) return;
    if (!canManageInviteAccess) {
      setInviteAccessError("You do not have permission to manage invite access.");
      setInviteAccessStatus(null);
      return;
    }

    const allowlistDomains = normalizeTextList(inviteAllowlistDomainsInput);
    const allowlistEmails = normalizeTextList(inviteAllowlistEmailsInput);
    const inviteJoinPassword = inviteJoinPolicyPasswordInput.trim();
    const hasPendingPassword = inviteJoinPassword.length > 0;
    const shouldClearPassword = clearInviteJoinPassword;
    if (!canManageInvitePassword && (hasPendingPassword || shouldClearPassword)) {
      setInviteAccessError("Only organization owners can change invite password.");
      setInviteAccessStatus(null);
      return;
    }
    if (hasPendingPassword && shouldClearPassword) {
      setInviteAccessError(
        "Set a new password or clear the current one, but not both at once.",
      );
      setInviteAccessStatus(null);
      return;
    }
    const effectiveHasPassword =
      (hasInviteJoinPassword && !shouldClearPassword) || hasPendingPassword;

    if (
      canManageInvitePassword &&
      requirePasswordForUnlisted &&
      !effectiveHasPassword
    ) {
      setInviteAccessError(
        canManageInvitePassword
          ? "Set an invite password before enabling password requirement."
          : "An owner must configure an invite password before this policy can be enabled.",
      );
      setInviteAccessStatus(null);
      return;
    }

    setIsSavingInviteAccess(true);
    setInviteAccessError(null);
    setInviteAccessStatus(null);
    try {
      await updateInviteAccessSettings(accessToken, activeTenantId, {
        allowlistDomains,
        allowlistEmails,
        ...(canManageInvitePassword
          ? { requirePasswordForUnlisted }
          : { requirePasswordForUnlisted: currentRequirePasswordForUnlisted }),
        ...(canManageInvitePassword && hasPendingPassword
          ? { inviteJoinPassword }
          : {}),
        ...(canManageInvitePassword && shouldClearPassword
          ? { clearInviteJoinPassword: true }
          : {}),
      });

      await tenantState.refresh();
      setInviteJoinPolicyPasswordInput("");
      setClearInviteJoinPassword(false);
      setInviteAccessStatus("Invite access settings saved.");
    } catch (error) {
      setInviteAccessError(
        error instanceof Error
          ? error.message
          : "Failed to save invite access settings",
      );
    } finally {
      setIsSavingInviteAccess(false);
    }
  }, [
    accessToken,
    activeTenantId,
    canManageInviteAccess,
    canManageInvitePassword,
    clearInviteJoinPassword,
    currentRequirePasswordForUnlisted,
    hasInviteJoinPassword,
    inviteAllowlistDomainsInput,
    inviteAllowlistEmailsInput,
    inviteJoinPolicyPasswordInput,
    isSavingInviteAccess,
    requirePasswordForUnlisted,
    tenantState,
  ]);

  const handleClearInviteJoinPasswordChange = useCallback(
    (nextValue: boolean) => {
      setClearInviteJoinPassword(nextValue);
      if (nextValue) {
        setInviteJoinPolicyPasswordInput("");
      }
    },
    [],
  );

  // TODO : remove in production
  const handleGrantAdminForDev = useCallback(async () => {
    if (!import.meta.env.DEV || !accessToken || isGrantingAdmin) return;

    setIsGrantingAdmin(true);
    setAdminToolStatus(null);
    try {
      const response = await fetch("/tenant/dev/grant-admin-self", {
        method: "POST",
        headers: authHeaders(accessToken),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        await signOutIfUnauthorizedStatus(response.status);
        const message =
          typeof payload?.message === "string"
            ? payload.message
            : "Failed to update role";
        setAdminToolStatus(message);
        return;
      }

      await tenantState.refresh();
      const roleKey =
        typeof payload?.roleKey === "string" ? payload.roleKey : null;
      setAdminToolStatus(
        roleKey === "admin" || roleKey === "member"
          ? `Role updated: ${roleKey}`
          : "Role updated.",
      );
    } catch {
      setAdminToolStatus("Network error while updating role.");
    } finally {
      setIsGrantingAdmin(false);
    }
  }, [accessToken, isGrantingAdmin, tenantState]);

  if (tenantState.isLoading) {
    return <DashboardLoadingView message="Loading tenant dashboard..." />;
  }

  if (tenantState.error) {
    return (
      <DashboardErrorView
        error={tenantState.error}
        onRetry={() => void tenantState.refresh()}
        onSignOut={() => void handleSignOut()}
      />
    );
  }

  if (tenantState.context && !tenantState.context.hasMembership) {
    if (effectiveInviteToken) {
      return (
        <InviteAutoJoinView
          isSubmitting={isSubmittingOnboarding}
          error={onboardingError}
          invitePassword={inviteJoinPasswordInput}
          showPasswordField={requiresInviteJoinPassword}
          onInvitePasswordChange={setInviteJoinPasswordInput}
          onRetry={() => void handleRetryInviteAutoJoin()}
          onSignOut={() => void handleSignOut()}
        />
      );
    }

    return (
      <OnboardingView
        mode={onboardingMode}
        tenantNameInput={tenantNameInput}
        inviteTokenInput={inviteTokenInput}
        invitePasswordInput={inviteJoinPasswordInput}
        isSubmitting={isSubmittingOnboarding}
        error={onboardingError}
        onModeChange={setOnboardingMode}
        onTenantNameChange={setTenantNameInput}
        onInviteTokenChange={setInviteTokenInput}
        onInvitePasswordChange={setInviteJoinPasswordInput}
        onSubmit={() => void handleOnboardingSubmit()}
        onSignOut={() => void handleSignOut()}
      />
    );
  }

  return (
    <TenantDashboardView
      tenantName={tenantContext?.tenant?.name ?? "Unknown"}
      tenantSlug={tenantContext?.tenant?.slug ?? null}
      currentRoleKey={currentRoleKey}
      dashboardError={dashboardError}
      isDashboardLoading={isDashboardLoading}
      isSigningOut={isSigningOut}
      canAccessAdminDashboard={canAccessAdminDashboard}
      isCurrentUserAdmin={isCurrentUserAdmin}
      canCreateInvites={canCreateInvites}
      canManageInviteAccess={canManageInviteAccess}
      canManageInvitePassword={canManageInvitePassword}
      tenantMembers={tenantMembers}
      inviteDescription={inviteDescription}
      inviteType={inviteType}
      inviteEmailInput={inviteEmailInput}
      inviteRoleKey={inviteRoleKey}
      isCreatingInvite={isCreatingInvite}
      inviteError={inviteError}
      inviteStatus={inviteStatus}
      createdInvite={createdInvite}
      inviteAllowlistDomainsInput={inviteAllowlistDomainsInput}
      inviteAllowlistEmailsInput={inviteAllowlistEmailsInput}
      requirePasswordForUnlisted={requirePasswordForUnlisted}
      hasInviteJoinPassword={hasInviteJoinPassword}
      inviteJoinPasswordInput={inviteJoinPolicyPasswordInput}
      clearInviteJoinPassword={clearInviteJoinPassword}
      isSavingInviteAccess={isSavingInviteAccess}
      inviteAccessError={inviteAccessError}
      inviteAccessStatus={inviteAccessStatus}
      showDevTool={import.meta.env.DEV}
      isGrantingAdmin={isGrantingAdmin}
      adminToolStatus={adminToolStatus}
      onEnterGame={() => navigate("/game")}
      onRefresh={() => void loadDashboardData()}
      onSignOut={() => void handleSignOut()}
      onInviteTypeChange={handleInviteTypeChange}
      onInviteEmailChange={setInviteEmailInput}
      onInviteRoleKeyChange={setInviteRoleKey}
      onCreateInvite={() => void handleCreateInvite()}
      onCopyInviteValue={(value, label) =>
        void handleCopyInviteValue(value, label)
      }
      onInviteAllowlistDomainsInputChange={setInviteAllowlistDomainsInput}
      onInviteAllowlistEmailsInputChange={setInviteAllowlistEmailsInput}
      onRequirePasswordForUnlistedChange={setRequirePasswordForUnlisted}
      onInviteJoinPasswordInputChange={setInviteJoinPolicyPasswordInput}
      onClearInviteJoinPasswordChange={handleClearInviteJoinPasswordChange}
      onSaveInviteAccessSettings={() => void handleSaveInviteAccessSettings()}
      onToggleAdminRole={() => void handleGrantAdminForDev()}
    />
  );
}
