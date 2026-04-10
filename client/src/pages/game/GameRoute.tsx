import { useEffect, useState } from "react";
import { Leva } from "leva";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { useTenantContext, type TenantAccessConfig } from "../../contexts/TenantContext";
import AvatarSelect from "../../components/ui/AvatarSelect";
import World from "../../components/scene/World";
import {
  ensureNotificationPermissionOnUserGesture,
  maybeRequestNotificationPermission,
} from "../../chat/notificationService";
import type { Player } from "../../types";

const STORAGE_KEY = "gather_poc_avatar";

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

/** Gameplay route keeps in-game admin controls limited to tenant policy settings. */
export default function GameRoute() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const { worldKey } = useParams<{ worldKey?: string }>();
  const tenantState = useTenantContext();
  const [player, setPlayer] = useState<Player | null>(null);
  const [activeWorldKey, setActiveWorldKey] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
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

  useEffect(() => {
    ensureNotificationPermissionOnUserGesture();
  }, []);

  useEffect(() => {
    // Keep URL bookmarkable by reflecting the latest server-confirmed world key.
    const normalizedCurrent = typeof worldKey === "string" ? worldKey.trim() : "";
    const normalizedActive = typeof activeWorldKey === "string" ? activeWorldKey.trim() : "";
    if (!normalizedActive || normalizedActive === normalizedCurrent) return;
    navigate(`/game/${normalizedActive}`, { replace: true });
  }, [activeWorldKey, navigate, worldKey]);

  useEffect(() => {
    const tenant = tenantState.context?.tenant;
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
  }, [tenantState.context?.tenant]);

  const currentRoleKey = tenantState.context?.roleKey ?? null;
  const canManageTenantSettings = !!tenantState.context?.permissions?.includes("tenant.settings.manage");

  function handleJoin(nextPlayer: Player) {
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

  async function handleSaveSettings() {
    const tenantId = tenantState.context?.tenant?.id;
    if (!tenantId || isSavingSettings) return;
    setIsSavingSettings(true);
    setSettingsError(null);
    setSettingsSuccess(null);
    try {
      await tenantState.saveTenantSettings(tenantId, tenantAccessPolicy, tenantAccessConfig);
      setSettingsSuccess("Tenant settings saved.");
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "Failed to save tenant settings");
    } finally {
      setIsSavingSettings(false);
    }
  }

  if (tenantState.isLoading) {
    return (
      <div style={centeredPageStyle}>
        <div style={cardStyle}>Loading tenant context...</div>
      </div>
    );
  }

  if (tenantState.error) {
    return (
      <div style={centeredPageStyle}>
        <div style={cardStyle}>
          <h2 style={cardTitleStyle}>Tenant Context Error</h2>
          <p style={cardTextStyle}>{tenantState.error}</p>
          <div style={actionsRowStyle}>
            <button type="button" style={primaryButtonStyle} onClick={() => void tenantState.refresh()}>
              Retry
            </button>
            <button type="button" style={secondaryButtonStyle} onClick={() => navigate("/dashboard")}>
              Dashboard
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
    return <Navigate to="/dashboard" replace />;
  }

  if (!player) {
    return <AvatarSelect initial={loadSaved()} onJoin={handleJoin} />;
  }

  return (
    <>
      <Leva hidden={import.meta.env.PROD} />
      <button type="button" onClick={handleSignOut} disabled={isSigningOut} style={logoutButtonStyle}>
        {isSigningOut ? "Signing out..." : "Log out"}
      </button>
      <button type="button" onClick={() => navigate("/dashboard")} style={dashboardButtonStyle}>
        Dashboard
      </button>
      <div style={roleBadgeStyle}>
        Role: {currentRoleKey ?? "none"}
      </div>
      {canManageTenantSettings && (
        <button type="button" onClick={() => setSettingsOpen((prev) => !prev)} style={tenantSettingsButtonStyle}>
          {settingsOpen ? "Close Tenant Settings" : "Tenant Settings"}
        </button>
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
      <World player={player} initialWorldKey={worldKey?.trim() || null} onWorldKeyChange={setActiveWorldKey} />
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

const dashboardButtonStyle: React.CSSProperties = {
  ...logoutButtonStyle,
  top: 56,
  background: "#263448",
  border: "1px solid #4d6b93",
};

const roleBadgeStyle: React.CSSProperties = {
  position: "fixed",
  top: 96,
  right: 16,
  zIndex: 1000,
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid #4f5968",
  background: "#121923",
  color: "#d8e0ec",
  fontSize: 12,
  minWidth: 120,
  textAlign: "center",
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

const centeredPageStyle: React.CSSProperties = {
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
  maxWidth: 460,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  borderRadius: 12,
  border: "1px solid #2e3a4f",
  background: "#121a26",
  padding: 20,
};

const cardTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 22,
};

const cardTextStyle: React.CSSProperties = {
  margin: 0,
  color: "#b8c4d3",
};

const actionsRowStyle: React.CSSProperties = {
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
