import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useTenantContext } from "../hooks/useTenantContext";

type JoinedTenant = {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  accessPolicy: "public" | "private";
  roleKey: string | null;
  roleName: string | null;
  joinedAt: string | null;
  updatedAt: string | null;
};

type TenantMember = {
  membershipId: string;
  userId: string;
  roleKey: string | null;
  roleName: string | null;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
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

async function fetchJoinedTenants(accessToken: string): Promise<JoinedTenant[]> {
  const response = await fetch("/tenant/memberships", {
    method: "GET",
    headers: authHeaders(accessToken),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const message = typeof payload?.message === "string" ? payload.message : "Failed to load organizations";
    throw new Error(message);
  }
  return Array.isArray(payload?.memberships) ? payload.memberships : [];
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

/** Tenant dashboard handles onboarding and non-game tenant administration flows. */
export default function DashboardRoute() {
  const { signOut, session } = useAuth();
  const navigate = useNavigate();
  const accessToken = session?.access_token ?? "";
  const tenantContextState = useTenantContext(accessToken);
  const [onboardingMode, setOnboardingMode] = useState<"create" | "invite">("create");
  const [tenantNameInput, setTenantNameInput] = useState("");
  const [inviteTokenInput, setInviteTokenInput] = useState("");
  const [isSubmittingOnboarding, setIsSubmittingOnboarding] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isGrantingAdmin, setIsGrantingAdmin] = useState(false);
  const [adminToolStatus, setAdminToolStatus] = useState<string | null>(null);
  const [joinedTenants, setJoinedTenants] = useState<JoinedTenant[]>([]);
  const [tenantMembers, setTenantMembers] = useState<TenantMember[]>([]);
  const [isDashboardLoading, setIsDashboardLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);

  const currentRoleKey = tenantContextState.context?.roleKey ?? null;
  const isCurrentUserAdmin = currentRoleKey === "admin";
  const canManageMembers = !!tenantContextState.context?.permissions?.includes("tenant.members.manage");
  const activeTenantId = tenantContextState.context?.tenant?.id ?? null;

  const loadDashboardData = useCallback(async () => {
    if (!accessToken || !tenantContextState.context?.hasMembership) return;
    setIsDashboardLoading(true);
    setDashboardError(null);
    try {
      const memberships = await fetchJoinedTenants(accessToken);
      setJoinedTenants(memberships);
      if (!canManageMembers || !activeTenantId) {
        setTenantMembers([]);
        return;
      }
      const members = await fetchTenantMembers(accessToken, activeTenantId);
      setTenantMembers(members);
    } catch (error) {
      setDashboardError(error instanceof Error ? error.message : "Failed to load dashboard data");
      setTenantMembers([]);
    } finally {
      setIsDashboardLoading(false);
    }
  }, [accessToken, activeTenantId, canManageMembers, tenantContextState.context?.hasMembership]);

  useEffect(() => {
    void loadDashboardData();
  }, [loadDashboardData]);

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
        await tenantContextState.createTenantDuringOnboarding(tenantNameInput);
      } else {
        await tenantContextState.joinTenantFromInvite(inviteTokenInput);
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

  async function handleGrantAdminForDev() {
    if (!import.meta.env.DEV || !accessToken || isGrantingAdmin) return;
    setIsGrantingAdmin(true);
    setAdminToolStatus(null);
    try {
      const response = await fetch("/tenant/dev/grant-admin-self", {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({}),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        const message = typeof payload?.message === "string" ? payload.message : "Failed to update role";
        setAdminToolStatus(message);
        return;
      }
      await tenantContextState.refresh();
      await loadDashboardData();
      const roleKey = typeof payload?.roleKey === "string" ? payload.roleKey : null;
      setAdminToolStatus(roleKey === "admin" || roleKey === "member" ? `Role updated: ${roleKey}` : "Role updated.");
    } catch {
      setAdminToolStatus("Network error while updating role.");
    } finally {
      setIsGrantingAdmin(false);
    }
  }

  if (tenantContextState.isLoading) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>Loading tenant dashboard...</div>
      </div>
    );
  }

  if (tenantContextState.error) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <h2 style={titleStyle}>Dashboard Error</h2>
          <p style={textStyle}>{tenantContextState.error}</p>
          <div style={actionsStyle}>
            <button type="button" style={primaryButtonStyle} onClick={() => void tenantContextState.refresh()}>
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

  if (tenantContextState.context && !tenantContextState.context.hasMembership) {
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
        <p style={textStyle}>Tenant: {tenantContextState.context?.tenant?.name ?? "Unknown"} | Role: {currentRoleKey ?? "none"}</p>
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

        <div style={sectionStyle}>
          <h3 style={sectionTitleStyle}>Organizations Joined</h3>
          {joinedTenants.length === 0 ? (
            <p style={textStyle}>No organizations found.</p>
          ) : (
            <ul style={listStyle}>
              {joinedTenants.map((tenant) => (
                <li key={tenant.tenantId} style={listItemStyle}>
                  <strong>{tenant.tenantName}</strong> ({tenant.tenantSlug}) | role: {tenant.roleKey ?? "unknown"}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div style={sectionStyle}>
          <h3 style={sectionTitleStyle}>Users In Current Organization</h3>
          {!canManageMembers ? (
            <p style={textStyle}>You do not have permission to view this list.</p>
          ) : tenantMembers.length === 0 ? (
            <p style={textStyle}>No active users found.</p>
          ) : (
            <ul style={listStyle}>
              {tenantMembers.map((member) => (
                <li key={member.membershipId} style={listItemStyle}>
                  <strong>{member.userId}</strong> | role: {member.roleKey ?? "unknown"} | status: {member.status}
                </li>
              ))}
            </ul>
          )}
        </div>

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
