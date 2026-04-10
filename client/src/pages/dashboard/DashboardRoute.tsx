import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { useTenantContext } from "../../contexts/TenantContext";
import { clearPendingNextPath } from "../../utils/nextPath";
import {
  authHeaders,
  createTenantInvite,
  fetchTenantMembers,
  readJson,
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

  const autoJoinAttemptedTokenRef = useRef<string | null>(null);
  const tenantContext = tenantState.context;
  const effectiveInviteToken = searchParams.get("inviteToken")?.trim() ?? "";

  const currentRoleKey = tenantContext?.roleKey ?? null;
  const isCurrentUserAdmin = currentRoleKey === "admin";
  const activeTenantId = tenantContext?.tenant?.id ?? null;

  const inviteDescription =
    inviteType === "personalized"
      ? "Personalized invite: one-time use and bound to a specific email. You can choose member or admin role."
      : "Group invite: reusable until expiry, no email target, and all joiners are assigned member role.";

  useEffect(() => {
    if (!effectiveInviteToken) return;
    setOnboardingMode("invite");
    setInviteTokenInput((current) =>
      current ? current : effectiveInviteToken,
    );
  }, [effectiveInviteToken]);

  const loadDashboardData = useCallback(async () => {
    if (
      !accessToken ||
      !tenantContext?.hasMembership ||
      !isCurrentUserAdmin ||
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
    isCurrentUserAdmin,
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
      await tenantState.joinTenantFromInvite(effectiveInviteToken);
      await loadDashboardData();
      const nextSearchParams = new URLSearchParams(searchParams);
      nextSearchParams.delete("inviteToken");
      setSearchParams(nextSearchParams, { replace: true });
      clearPendingNextPath();
      setInviteTokenInput("");
      autoJoinAttemptedTokenRef.current = null;
    } catch (error) {
      setOnboardingError(
        error instanceof Error
          ? error.message
          : "Failed to complete tenant setup",
      );
      autoJoinAttemptedTokenRef.current = null;
    } finally {
      setIsSubmittingOnboarding(false);
    }
  }, [
    effectiveInviteToken,
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
        await tenantState.joinTenantFromInvite(inviteTokenInput);
        const nextSearchParams = new URLSearchParams(searchParams);
        nextSearchParams.delete("inviteToken");
        setSearchParams(nextSearchParams, { replace: true });
      }

      await loadDashboardData();
      setTenantNameInput("");
      setInviteTokenInput("");
    } catch (error) {
      setOnboardingError(
        error instanceof Error
          ? error.message
          : "Failed to complete tenant setup",
      );
    } finally {
      setIsSubmittingOnboarding(false);
    }
  }, [
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
        emailOptional: inviteType === "personalized" ? email : null,
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
        isSubmitting={isSubmittingOnboarding}
        error={onboardingError}
        onModeChange={setOnboardingMode}
        onTenantNameChange={setTenantNameInput}
        onInviteTokenChange={setInviteTokenInput}
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
      isCurrentUserAdmin={isCurrentUserAdmin}
      tenantMembers={tenantMembers}
      inviteDescription={inviteDescription}
      inviteType={inviteType}
      inviteEmailInput={inviteEmailInput}
      inviteRoleKey={inviteRoleKey}
      isCreatingInvite={isCreatingInvite}
      inviteError={inviteError}
      inviteStatus={inviteStatus}
      createdInvite={createdInvite}
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
      onToggleAdminRole={() => void handleGrantAdminForDev()}
    />
  );
}
