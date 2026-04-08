import { useEffect, useState } from "react";
import { Leva } from "leva";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useTenantContext, type TenantAccessConfig } from "../hooks/useTenantContext";
import AvatarSelect from "../components/ui/AvatarSelect";
import World from "../components/scene/World";
import {
  ensureNotificationPermissionOnUserGesture,
  maybeRequestNotificationPermission,
} from "../chat/notificationService";
import type { Player } from "../types";

const STORAGE_KEY = "gather_poc_avatar";

// this information should be moved to backend
/** Load locally persisted avatar selection for quick re-entry. */
function loadSaved(): Player | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsedPlayer = JSON.parse(raw) as { name?: string; avatar?: { shirt?: string } };
    if (typeof parsedPlayer?.name !== "string" || typeof parsedPlayer?.avatar?.shirt !== "string") return null;
    return { name: parsedPlayer.name, avatar: { shirt: parsedPlayer.avatar.shirt } };
  } catch {
    return null;
  }
}

/** Gate into avatar selection until a local player profile is chosen. */
export default function GameRoute() {
  const { signOut, session } = useAuth();
  const accessToken = session?.access_token ?? "";
  const tenantContextState = useTenantContext(accessToken);
  const navigate = useNavigate();
  const { worldKey } = useParams<{ worldKey?: string }>();
  const [player, setPlayer] = useState<Player | null>(null);
  const [activeWorldKey, setActiveWorldKey] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isGrantingAdmin, setIsGrantingAdmin] = useState(false);
  const [adminToolStatus, setAdminToolStatus] = useState<string | null>(null);
  const [bootstrapMode, setBootstrapMode] = useState<"create" | "invite">("create");
  const [tenantNameInput, setTenantNameInput] = useState("");
  const [inviteTokenInput, setInviteTokenInput] = useState("");
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSuccess, setSettingsSuccess] = useState<string | null>(null);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [tenantAccessPolicy, setTenantAccessPolicy] = useState<"public" | "private">("public");
  const [tenantAccessConfig, setTenantAccessConfig] = useState<TenantAccessConfig>({
    guestZoneEnforced: false,
    guestCanChat: true,
    guestCanTag: true,
    guestCanTeleport: false,
    memberCanTag: true,
    memberCanTeleport: true,
  });

  // Install permission/audio priming hooks as soon as the game route loads so
  // the very first user gesture can unlock audio and trigger notification prompt.
  useEffect(() => {
    ensureNotificationPermissionOnUserGesture();
  }, []);

  useEffect(() => {
    const normalizedCurrent = typeof worldKey === "string" ? worldKey.trim() : "";
    const normalizedActive = typeof activeWorldKey === "string" ? activeWorldKey.trim() : "";
    if (!normalizedActive || normalizedActive === normalizedCurrent) return;
    navigate(`/game/${normalizedActive}`, { replace: true });
  }, [activeWorldKey, navigate, worldKey]);

  useEffect(() => {
    const tenant = tenantContextState.context?.tenant;
    if (!tenant) return;
    setTenantAccessPolicy(tenant.accessPolicy);
    setTenantAccessConfig({
      guestZoneEnforced: !!tenant.accessConfig?.guestZoneEnforced,
      guestCanChat: !!tenant.accessConfig?.guestCanChat,
      guestCanTag: !!tenant.accessConfig?.guestCanTag,
      guestCanTeleport: !!tenant.accessConfig?.guestCanTeleport,
      memberCanTag: !!tenant.accessConfig?.memberCanTag,
      memberCanTeleport: !!tenant.accessConfig?.memberCanTeleport,
      updatedBy: tenant.accessConfig?.updatedBy ?? null,
      updatedAt: tenant.accessConfig?.updatedAt ?? null,
    });
  }, [tenantContextState.context?.tenant]);

  /** Persist selected player profile and enter the world scene. */
  function handleJoin(nextPlayer: Player) {
    // Join click/submit is a user gesture, so this is the best point to ask.
    maybeRequestNotificationPermission();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextPlayer));
    setPlayer(nextPlayer);
  }

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

  async function handleGrantAdminForDev() {
    if (!accessToken || isGrantingAdmin) return;

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
        const message = typeof payload?.message === "string" ? payload.message : "Failed to grant admin role";
        setAdminToolStatus(message);
        return;
      }
      const nextRoleKey = typeof payload?.roleKey === "string"
        ? payload.roleKey
        : typeof payload?.role === "string"
          ? payload.role
          : null;
      if (nextRoleKey === "admin") {
        setAdminToolStatus("Role updated: admin");
      } else if (nextRoleKey === "member") {
        setAdminToolStatus("Role updated: member");
      } else {
        setAdminToolStatus("Role updated.");
      }
      await tenantContextState.refresh();
    } catch {
      setAdminToolStatus("Network error while granting admin role.");
    } finally {
      setIsGrantingAdmin(false);
    }
  }

  async function handleBootstrapSubmit() {
    if (isBootstrapping) return;
    setIsBootstrapping(true);
    setBootstrapError(null);
    try {
      if (bootstrapMode === "create") {
        await tenantContextState.bootstrapCreateTenant(tenantNameInput);
      } else {
        await tenantContextState.bootstrapJoinInvite(inviteTokenInput);
      }
      setTenantNameInput("");
      setInviteTokenInput("");
    } catch (error) {
      setBootstrapError(error instanceof Error ? error.message : "Failed to complete tenant setup");
    } finally {
      setIsBootstrapping(false);
    }
  }

  async function handleSaveSettings() {
    const tenantId = tenantContextState.context?.tenant?.id;
    if (!tenantId || isSavingSettings) return;
    setIsSavingSettings(true);
    setSettingsError(null);
    setSettingsSuccess(null);
    try {
      await tenantContextState.saveTenantSettings(tenantId, tenantAccessPolicy, tenantAccessConfig);
      setSettingsSuccess("Tenant settings saved.");
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "Failed to save tenant settings");
    } finally {
      setIsSavingSettings(false);
    }
  }

  if (tenantContextState.isLoading) {
    return (
      <div style={gatePageStyle}>
        <div style={gateCardStyle}>Loading tenant context...</div>
      </div>
    );
  }

  if (tenantContextState.error) {
    return (
      <div style={gatePageStyle}>
        <div style={gateCardStyle}>
          <h2 style={gateTitleStyle}>Tenant Context Error</h2>
          <p style={gateTextStyle}>{tenantContextState.error}</p>
          <div style={gateActionsStyle}>
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
      <div style={gatePageStyle}>
        <div style={gateCardStyle}>
          <h2 style={gateTitleStyle}>Set Up Your Organization</h2>
          <p style={gateTextStyle}>Create a tenant organization or join with an invite token before entering the game.</p>
          <div style={modeToggleStyle}>
            <button
              type="button"
              style={bootstrapMode === "create" ? activeModeButtonStyle : modeButtonStyle}
              onClick={() => setBootstrapMode("create")}
            >
              Create Organization
            </button>
            <button
              type="button"
              style={bootstrapMode === "invite" ? activeModeButtonStyle : modeButtonStyle}
              onClick={() => setBootstrapMode("invite")}
            >
              Join Invite
            </button>
          </div>
          {bootstrapMode === "create" ? (
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
          {bootstrapError && <p style={errorTextStyle}>{bootstrapError}</p>}
          <div style={gateActionsStyle}>
            <button type="button" style={primaryButtonStyle} disabled={isBootstrapping} onClick={() => void handleBootstrapSubmit()}>
              {isBootstrapping ? "Submitting..." : "Continue"}
            </button>
            <button type="button" style={secondaryButtonStyle} onClick={() => void handleSignOut()}>
              Log out
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!player) {
    return <AvatarSelect initial={loadSaved()} onJoin={handleJoin} />;
  }

  const canManageTenantSettings = !!tenantContextState.context?.permissions?.includes("tenant.settings.manage");

  return (
    <>
      <Leva hidden={import.meta.env.PROD} />
      <button
        type="button"
        onClick={handleSignOut}
        disabled={isSigningOut}
        style={logoutButtonStyle}
      >
        {isSigningOut ? "Signing out..." : "Log out"}
      </button>
      {canManageTenantSettings && (
        <button
          type="button"
          onClick={() => setSettingsOpen((prev) => !prev)}
          style={tenantSettingsButtonStyle}
        >
          {settingsOpen ? "Close Tenant Settings" : "Tenant Settings"}
        </button>
      )}
      {import.meta.env.DEV && (
        <>
          <button
            type="button"
            onClick={handleGrantAdminForDev}
            disabled={isGrantingAdmin}
            style={devAdminButtonStyle}
          >
            {isGrantingAdmin ? "Setting admin..." : "DEV: Set Me Admin"}
          </button>
          {adminToolStatus && <div style={devAdminStatusStyle}>{adminToolStatus}</div>}
        </>
      )}
      {settingsOpen && canManageTenantSettings && (
        <div style={tenantSettingsPanelStyle}>
          <h3 style={panelTitleStyle}>Tenant Access Settings</h3>
          <label style={fieldLabelStyle}>
            Access Policy
            <select
              style={selectStyle}
              value={tenantAccessPolicy}
              onChange={(event) => setTenantAccessPolicy(event.target.value as "public" | "private")}
            >
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
          </label>

          <label style={checkboxRowStyle}>
            <input
              type="checkbox"
              checked={tenantAccessConfig.guestZoneEnforced}
              onChange={(event) => setTenantAccessConfig((prev) => ({ ...prev, guestZoneEnforced: event.target.checked }))}
            />
            Guest zone enforced
          </label>
          <label style={checkboxRowStyle}>
            <input
              type="checkbox"
              checked={tenantAccessConfig.guestCanChat}
              onChange={(event) => setTenantAccessConfig((prev) => ({ ...prev, guestCanChat: event.target.checked }))}
            />
            Guest can chat
          </label>
          <label style={checkboxRowStyle}>
            <input
              type="checkbox"
              checked={tenantAccessConfig.guestCanTag}
              onChange={(event) => setTenantAccessConfig((prev) => ({ ...prev, guestCanTag: event.target.checked }))}
            />
            Guest can tag
          </label>
          <label style={checkboxRowStyle}>
            <input
              type="checkbox"
              checked={tenantAccessConfig.guestCanTeleport}
              onChange={(event) => setTenantAccessConfig((prev) => ({ ...prev, guestCanTeleport: event.target.checked }))}
            />
            Guest can teleport
          </label>
          <label style={checkboxRowStyle}>
            <input
              type="checkbox"
              checked={tenantAccessConfig.memberCanTag}
              onChange={(event) => setTenantAccessConfig((prev) => ({ ...prev, memberCanTag: event.target.checked }))}
            />
            Member can tag
          </label>
          <label style={checkboxRowStyle}>
            <input
              type="checkbox"
              checked={tenantAccessConfig.memberCanTeleport}
              onChange={(event) => setTenantAccessConfig((prev) => ({ ...prev, memberCanTeleport: event.target.checked }))}
            />
            Member can teleport
          </label>
          {settingsError && <p style={errorTextStyle}>{settingsError}</p>}
          {settingsSuccess && <p style={successTextStyle}>{settingsSuccess}</p>}
          <button type="button" style={primaryButtonStyle} disabled={isSavingSettings} onClick={() => void handleSaveSettings()}>
            {isSavingSettings ? "Saving..." : "Save Settings"}
          </button>
        </div>
      )}
      <World
        player={player}
        initialWorldKey={worldKey?.trim() || null}
        onWorldKeyChange={setActiveWorldKey}
      />
    </>
  );
}

const logoutButtonStyle: React.CSSProperties = {
  position: "fixed",
  top: 16,
  right: 16,
  zIndex: 1000,
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #5d6775",
  background: "#1d2430",
  color: "#ffffff",
  fontSize: 14,
  cursor: "pointer",
};

const devAdminButtonStyle: React.CSSProperties = {
  ...logoutButtonStyle,
  top: 56,
  background: "#16331f",
  border: "1px solid #2f7d47",
};

const devAdminStatusStyle: React.CSSProperties = {
  position: "fixed",
  top: 96,
  right: 16,
  zIndex: 1000,
  maxWidth: 320,
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid #4f5968",
  background: "#121923",
  color: "#d8e0ec",
  fontSize: 12,
};

const tenantSettingsButtonStyle: React.CSSProperties = {
  ...logoutButtonStyle,
  top: 136,
  background: "#263448",
  border: "1px solid #4d6b93",
};

const tenantSettingsPanelStyle: React.CSSProperties = {
  position: "fixed",
  top: 176,
  right: 16,
  width: 320,
  zIndex: 1000,
  padding: 12,
  borderRadius: 10,
  border: "1px solid #4f5968",
  background: "#101720",
  color: "#d9e3ef",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const panelTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 16,
};

const fieldLabelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  fontSize: 13,
};

const selectStyle: React.CSSProperties = {
  borderRadius: 6,
  border: "1px solid #4f5968",
  background: "#1b2532",
  color: "#fff",
  padding: "6px 8px",
};

const checkboxRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
};

const gatePageStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#0a0f16",
  color: "#fff",
  padding: 16,
};

const gateCardStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 460,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  borderRadius: 12,
  border: "1px solid #2e3a4f",
  background: "#121a26",
  padding: 20,
};

const gateTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 22,
};

const gateTextStyle: React.CSSProperties = {
  margin: 0,
  color: "#b8c4d3",
};

const gateActionsStyle: React.CSSProperties = {
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

const successTextStyle: React.CSSProperties = {
  margin: 0,
  color: "#86efac",
  fontSize: 13,
};
