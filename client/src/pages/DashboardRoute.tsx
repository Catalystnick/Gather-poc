import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useTenantContext } from "../contexts/TenantContext";
import { clearPendingNextPath } from "../utils/nextPath";


type TenantMember = {
  membershipId: string;
  userId: string;
  email: string | null;
  displayName: string | null;
  roleKey: string | null;
};

type InviteDelivery = {
  attempted: boolean;
  sent: boolean;
  provider: string;
  errorCode?: string | null;
};

type TenantInvite = {
  tenantId: string;
  inviteToken: string;
  inviteUrl: string | null;
  roleKey: string;
  emailOptional: string | null;
  expiresAt: string;
  delivery: InviteDelivery;
};

function authHeaders(accessToken: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
}

async function readJson(response: Response) {
  return response.json().catch(() => null);
}


async function fetchTenantMembers(accessToken: string, tenantId: string): Promise<TenantMember[]> {
  const response = await fetch(`/tenant/${tenantId}/members`, {
    method: "GET",
    headers: authHeaders(accessToken),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const message = typeof payload?.message === "string" ? payload.message : "Failed to load users";
    throw new Error(message);
  }
  return Array.isArray(payload?.members) ? payload.members : [];
}

async function createTenantInvite(
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
    const message = typeof payload?.message === "string" ? payload.message : "Failed to create invite";
    throw new Error(message);
  }
  return payload as TenantInvite;
}


/** Tenant dashboard handles onboarding and non-game tenant administration flows. */
export default function DashboardRoute() {
  const { signOut, session } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const accessToken = session?.access_token ?? "";
  const tenantState = useTenantContext();
  const [onboardingMode, setOnboardingMode] = useState<"create" | "invite">("create");
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
  const [inviteRoleKey, setInviteRoleKey] = useState<"member" | "admin">("member");
  const [isCreatingInvite, setIsCreatingInvite] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);
  const [createdInvite, setCreatedInvite] = useState<TenantInvite | null>(null);
  const autoJoinAttemptedTokenRef = useRef<string | null>(null);
  const tenantContext = tenantState.context;
  const joinTenantFromInvite = tenantState.joinTenantFromInvite;

  const currentRoleKey = tenantContext?.roleKey ?? null;
  const isCurrentUserAdmin = currentRoleKey === "admin";
  const activeTenantId = tenantContext?.tenant?.id ?? null;
  const effectiveInviteToken = searchParams.get("inviteToken")?.trim() ?? "";

  useEffect(() => {
    if (!effectiveInviteToken) return;
    setOnboardingMode("invite");
    setInviteTokenInput((current) => (current ? current : effectiveInviteToken));
  }, [effectiveInviteToken]);

  const loadDashboardData = useCallback(async () => {
    if (!accessToken || !tenantContext?.hasMembership || !isCurrentUserAdmin || !activeTenantId) return;
    setIsDashboardLoading(true);
    setDashboardError(null);
    try {
      const members = await fetchTenantMembers(accessToken, activeTenantId);
      setTenantMembers(members);
    } catch (error) {
      setDashboardError(error instanceof Error ? error.message : "Failed to load dashboard data");
      setTenantMembers([]);
    } finally {
      setIsDashboardLoading(false);
    }
  }, [accessToken, activeTenantId, isCurrentUserAdmin, tenantContext?.hasMembership]);

  useEffect(() => {
    void loadDashboardData();
  }, [loadDashboardData]);

  useEffect(() => {
    if (!effectiveInviteToken) {
      autoJoinAttemptedTokenRef.current = null;
      return;
    }
    if (!tenantContext || tenantContext.hasMembership) return;
    if (autoJoinAttemptedTokenRef.current === effectiveInviteToken) return;

    autoJoinAttemptedTokenRef.current = effectiveInviteToken;

    async function autoJoin() {
      setIsSubmittingOnboarding(true);
      setOnboardingError(null);
      try {
        await joinTenantFromInvite(effectiveInviteToken);
        await loadDashboardData();
        const nextSearchParams = new URLSearchParams(searchParams);
        nextSearchParams.delete("inviteToken");
        setSearchParams(nextSearchParams, { replace: true });
        clearPendingNextPath();
        setInviteTokenInput("");
        autoJoinAttemptedTokenRef.current = null;
      } catch (error) {
        setOnboardingError(error instanceof Error ? error.message : "Failed to complete tenant setup");
        autoJoinAttemptedTokenRef.current = null;
      } finally {
        setIsSubmittingOnboarding(false);
      }
    }

    void autoJoin();
  }, [
    effectiveInviteToken,
    joinTenantFromInvite,
    loadDashboardData,
    searchParams,
    setSearchParams,
    tenantContext,
  ]);

  async function handleSignOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await signOut();
      navigate("/login", { replace: true });
    } finally {
      setIsSigningOut(false);
    }
  }

  async function handleOnboardingSubmit() {
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
      setOnboardingError(error instanceof Error ? error.message : "Failed to complete tenant setup");
    } finally {
      setIsSubmittingOnboarding(false);
    }
  }

  async function handleCopyInviteValue(value: string, label: string) {
    if (!value) return;
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setInviteStatus(`${label} copied.`);
    } catch {
      setInviteStatus(`Failed to copy ${label.toLowerCase()}.`);
    }
  }

  async function handleCreateInvite() {
    if (!accessToken || !activeTenantId || isCreatingInvite) return;
    setIsCreatingInvite(true);
    setInviteError(null);
    setInviteStatus(null);
    try {
      const email = inviteEmailInput.trim();
      const invite = await createTenantInvite(accessToken, activeTenantId, {
        roleKey: inviteRoleKey,
        emailOptional: email || null,
      });
      setCreatedInvite(invite);
      if (invite.delivery.sent) {
        setInviteStatus("Invite created and email sent.");
      } else if (email) {
        setInviteStatus("Invite created. Email was not sent, share token or link manually.");
      } else {
        setInviteStatus("Invite created. Share token or link manually.");
      }
      setInviteEmailInput("");
    } catch (error) {
      setInviteError(error instanceof Error ? error.message : "Failed to create invite");
      setCreatedInvite(null);
    } finally {
      setIsCreatingInvite(false);
    }
  }

  async function handleGrantAdminForDev() {
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
        const message = typeof payload?.message === "string" ? payload.message : "Failed to update role";
        setAdminToolStatus(message);
        return;
      }
      await tenantState.refresh();
      const roleKey = typeof payload?.roleKey === "string" ? payload.roleKey : null;
      setAdminToolStatus(roleKey === "admin" || roleKey === "member" ? `Role updated: ${roleKey}` : "Role updated.");
    } catch {
      setAdminToolStatus("Network error while updating role.");
    } finally {
      setIsGrantingAdmin(false);
    }
  }

  if (tenantState.isLoading) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>Loading tenant dashboard...</div>
      </div>
    );
  }

  if (tenantState.error) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <h2 style={titleStyle}>Dashboard Error</h2>
          <p style={textStyle}>{tenantState.error}</p>
          <div style={actionsStyle}>
            <button type="button" style={primaryButtonStyle} onClick={() => void tenantState.refresh()}>
              Retry
            </button>
            <button type="button" style={secondaryButtonStyle} onClick={() => void handleSignOut()}>
              Log out
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (tenantState.context && !tenantState.context.hasMembership) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <h2 style={titleStyle}>Set Up Your Organization</h2>
          <p style={textStyle}>Create an organization or join with an invite token before entering the game.</p>
          <div style={modeToggleStyle}>
            <button type="button" style={onboardingMode === "create" ? activeModeButtonStyle : modeButtonStyle} onClick={() => setOnboardingMode("create")}>
              Create Organization
            </button>
            <button type="button" style={onboardingMode === "invite" ? activeModeButtonStyle : modeButtonStyle} onClick={() => setOnboardingMode("invite")}>
              Join Invite
            </button>
          </div>
          {onboardingMode === "create" ? (
            <input style={inputStyle} type="text" value={tenantNameInput} onChange={(event) => setTenantNameInput(event.target.value)} placeholder="Organization name" />
          ) : (
            <input style={inputStyle} type="text" value={inviteTokenInput} onChange={(event) => setInviteTokenInput(event.target.value)} placeholder="Invite token" />
          )}
          {onboardingError && <p style={errorTextStyle}>{onboardingError}</p>}
          <div style={actionsStyle}>
            <button type="button" style={primaryButtonStyle} disabled={isSubmittingOnboarding} onClick={() => void handleOnboardingSubmit()}>
              {isSubmittingOnboarding ? "Submitting..." : "Continue"}
            </button>
            <button type="button" style={secondaryButtonStyle} onClick={() => void handleSignOut()}>
              Log out
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        <h2 style={titleStyle}>Organization Dashboard</h2>
        <p style={textStyle}>Tenant: {tenantState.context?.tenant?.name ?? "Unknown"} | Role: {currentRoleKey ?? "none"}</p>
        {dashboardError && <p style={errorTextStyle}>{dashboardError}</p>}
        {isDashboardLoading && <p style={textStyle}>Loading organizations and users...</p>}
        <div style={actionsStyle}>
          <button type="button" style={primaryButtonStyle} onClick={() => navigate("/game")}>
            Enter Game
          </button>
          <button type="button" style={secondaryButtonStyle} onClick={() => void loadDashboardData()}>
            Refresh
          </button>
          <button type="button" style={secondaryButtonStyle} onClick={() => void handleSignOut()}>
            {isSigningOut ? "Signing out..." : "Log out"}
          </button>
        </div>

        {isCurrentUserAdmin && tenantContext?.tenant && (
        <div style={sectionStyle}>
          <h3 style={sectionTitleStyle}>Organization</h3>
          <p style={textStyle}>
            <strong>{tenantContext.tenant.name}</strong> ({tenantContext.tenant.slug}) | role: {currentRoleKey ?? "unknown"}
          </p>
        </div>
        )}

        {isCurrentUserAdmin && (
        <div style={sectionStyle}>
          <h3 style={sectionTitleStyle}>Users In Current Organization</h3>
          {tenantMembers.length === 0 ? (
            <p style={textStyle}>No active users found.</p>
          ) : (
            <ul style={listStyle}>
              {tenantMembers.map((member) => (
                <li key={member.membershipId} style={listItemStyle}>
                  <strong>{member.displayName ?? member.email ?? member.userId}</strong>
                  {member.email && member.displayName && <span style={{ color: "#888" }}> — {member.email}</span>}
                  {" "}| role: {member.roleKey ?? "unknown"}
                </li>
              ))}
            </ul>
          )}
        </div>
        )}

        {isCurrentUserAdmin && (
        <div style={sectionStyle}>
          <h3 style={sectionTitleStyle}>Invite Users</h3>
          <p style={textStyle}>Send by email, or create an invite token/link for manual sharing.</p>
          <input
            style={inputStyle}
            type="email"
            placeholder="employee@company.com (optional)"
            value={inviteEmailInput}
            onChange={(event) => setInviteEmailInput(event.target.value)}
          />
          <select
            style={inputStyle}
            value={inviteRoleKey}
            onChange={(event) => setInviteRoleKey(event.target.value === "admin" ? "admin" : "member")}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <div style={actionsStyle}>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={isCreatingInvite}
              onClick={() => void handleCreateInvite()}
            >
              {isCreatingInvite ? "Creating..." : "Create Invite"}
            </button>
          </div>
          {inviteError && <p style={errorTextStyle}>{inviteError}</p>}
          {inviteStatus && <p style={textStyle}>{inviteStatus}</p>}
          {createdInvite && (
            <div style={inviteResultStyle}>
              <p style={textStyle}>Role: {createdInvite.roleKey} | Expires: {new Date(createdInvite.expiresAt).toLocaleString()}</p>
              {!createdInvite.delivery.sent && createdInvite.delivery.errorCode && (
                <p style={textStyle}>Delivery: {createdInvite.delivery.errorCode}</p>
              )}
              <p style={tokenTextStyle}>Token: {createdInvite.inviteToken}</p>
              {createdInvite.inviteUrl && <p style={tokenTextStyle}>Link: {createdInvite.inviteUrl}</p>}
              <div style={actionsStyle}>
                <button
                  type="button"
                  style={secondaryButtonStyle}
                  onClick={() => void handleCopyInviteValue(createdInvite.inviteToken, "Token")}
                >
                  Copy Token
                </button>
                {createdInvite.inviteUrl && (
                  <button
                    type="button"
                    style={secondaryButtonStyle}
                    onClick={() => void handleCopyInviteValue(createdInvite.inviteUrl ?? "", "Link")}
                  >
                    Copy Link
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
        )}

        {import.meta.env.DEV && (
          <div style={sectionStyle}>
            <h3 style={sectionTitleStyle}>Dev Tool</h3>
            <button type="button" style={secondaryButtonStyle} disabled={isGrantingAdmin} onClick={() => void handleGrantAdminForDev()}>
              {isGrantingAdmin ? "Updating role..." : isCurrentUserAdmin ? "Set Me Member" : "Set Me Admin"}
            </button>
            {adminToolStatus && <p style={textStyle}>{adminToolStatus}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#0a0f16",
  color: "#fff",
  padding: 16,
};

const cardStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 720,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  borderRadius: 12,
  border: "1px solid #2e3a4f",
  background: "#121a26",
  padding: 20,
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 22,
};

const sectionTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 16,
};

const textStyle: React.CSSProperties = {
  margin: 0,
  color: "#b8c4d3",
};

const actionsStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
};

const primaryButtonStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #396ecf",
  background: "#2d5cb5",
  color: "#fff",
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #5d6775",
  background: "#1d2430",
  color: "#fff",
  cursor: "pointer",
};

const modeToggleStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
};

const modeButtonStyle: React.CSSProperties = {
  ...secondaryButtonStyle,
  flex: 1,
};

const activeModeButtonStyle: React.CSSProperties = {
  ...primaryButtonStyle,
  flex: 1,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  borderRadius: 8,
  border: "1px solid #4f5968",
  background: "#1b2532",
  color: "#fff",
  padding: "9px 10px",
};

const errorTextStyle: React.CSSProperties = {
  margin: 0,
  color: "#fca5a5",
  fontSize: 13,
};

const sectionStyle: React.CSSProperties = {
  marginTop: 6,
  paddingTop: 10,
  borderTop: "1px solid #2e3a4f",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const listStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const listItemStyle: React.CSSProperties = {
  color: "#d3deed",
  fontSize: 13,
};

const inviteResultStyle: React.CSSProperties = {
  border: "1px solid #2e3a4f",
  borderRadius: 8,
  padding: 10,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const tokenTextStyle: React.CSSProperties = {
  margin: 0,
  color: "#d3deed",
  fontSize: 12,
  overflowWrap: "anywhere",
};
