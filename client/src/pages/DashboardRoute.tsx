import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useTenantContext } from "../hooks/useTenantContext";

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

  const currentRoleKey = tenantContextState.context?.roleKey ?? null;
  const isCurrentUserAdmin = currentRoleKey === "admin";

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
      setTenantNameInput("");
      setInviteTokenInput("");
    } catch (error) {
      setOnboardingError(error instanceof Error ? error.message : "Failed to complete tenant setup");
    } finally {
      setIsSubmittingOnboarding(false);
    }
  }

  async function handleGrantAdminForDev() {
    // Dev-only helper for local testing of permission-gated flows.
    if (!import.meta.env.DEV || !accessToken || isGrantingAdmin) return;
    setIsGrantingAdmin(true);
    setAdminToolStatus(null);
    try {
      const response = await fetch("/tenant/dev/grant-admin-self", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({}),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = typeof payload?.message === "string" ? payload.message : "Failed to update role";
        setAdminToolStatus(message);
        return;
      }
      await tenantContextState.refresh();
      const roleKey = typeof payload?.roleKey === "string" ? payload.roleKey : null;
      if (roleKey === "admin" || roleKey === "member") {
        setAdminToolStatus(`Role updated: ${roleKey}`);
      } else {
        setAdminToolStatus("Role updated.");
      }
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
            <button
              type="button"
              style={onboardingMode === "create" ? activeModeButtonStyle : modeButtonStyle}
              onClick={() => setOnboardingMode("create")}
            >
              Create Organization
            </button>
            <button
              type="button"
              style={onboardingMode === "invite" ? activeModeButtonStyle : modeButtonStyle}
              onClick={() => setOnboardingMode("invite")}
            >
              Join Invite
            </button>
          </div>
          {onboardingMode === "create" ? (
            <input
              style={inputStyle}
              type="text"
              value={tenantNameInput}
              onChange={(event) => setTenantNameInput(event.target.value)}
              placeholder="Organization name"
            />
          ) : (
            <input
              style={inputStyle}
              type="text"
              value={inviteTokenInput}
              onChange={(event) => setInviteTokenInput(event.target.value)}
              placeholder="Invite token"
            />
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
        <p style={textStyle}>
          Tenant: {tenantContextState.context?.tenant?.name ?? "Unknown"} | Role: {currentRoleKey ?? "none"}
        </p>
        <p style={textStyle}>Use this dashboard for onboarding, invites, member management, and role administration.</p>
        <div style={actionsStyle}>
          <button type="button" style={primaryButtonStyle} onClick={() => navigate("/game")}>
            Enter Game
          </button>
          <button type="button" style={secondaryButtonStyle} onClick={() => void handleSignOut()}>
            {isSigningOut ? "Signing out..." : "Log out"}
          </button>
        </div>
        {import.meta.env.DEV && (
          <div style={devToolBoxStyle}>
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
  maxWidth: 520,
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

const devToolBoxStyle: React.CSSProperties = {
  marginTop: 8,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  paddingTop: 8,
  borderTop: "1px solid #2e3a4f",
};
