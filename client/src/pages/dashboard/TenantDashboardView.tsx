import { useEffect, useState } from "react";
import type {
  InviteRoleKey,
  InviteType,
  TenantInvite,
  TenantMember,
} from "./dashboardTypes";
import {
  actionsStyle,
  activeModeButtonStyle,
  errorTextStyle,
  inputStyle,
  inviteResultStyle,
  listItemStyle,
  listStyle,
  modeButtonStyle,
  modeToggleStyle,
  orgDashboardCardStyle,
  orgDashboardScrollStyle,
  pageStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
  sectionStyle,
  sectionTitleStyle,
  textStyle,
  titleStyle,
  tokenTextStyle,
} from "./dashboardStyles";

type TenantDashboardViewProps = {
  tenantName: string;
  tenantSlug: string | null;
  currentRoleKey: string | null;
  dashboardError: string | null;
  isDashboardLoading: boolean;
  isSigningOut: boolean;
  canAccessAdminDashboard: boolean;
  isCurrentUserAdmin: boolean;
  canCreateInvites: boolean;
  canManageInviteAccess: boolean;
  canManageInvitePassword: boolean;
  tenantMembers: TenantMember[];
  inviteDescription: string;
  inviteType: InviteType;
  inviteEmailInput: string;
  inviteRoleKey: InviteRoleKey;
  isCreatingInvite: boolean;
  inviteError: string | null;
  inviteStatus: string | null;
  createdInvite: TenantInvite | null;
  inviteAllowlistDomainsInput: string;
  inviteAllowlistEmailsInput: string;
  requirePasswordForUnlisted: boolean;
  hasInviteJoinPassword: boolean;
  inviteJoinPasswordInput: string;
  clearInviteJoinPassword: boolean;
  isSavingInviteAccess: boolean;
  inviteAccessError: string | null;
  inviteAccessStatus: string | null;
  showDevTool: boolean;
  isGrantingAdmin: boolean;
  adminToolStatus: string | null;
  onEnterGame: () => void;
  onRefresh: () => void;
  onSignOut: () => void;
  onInviteTypeChange: (nextType: InviteType) => void;
  onInviteEmailChange: (value: string) => void;
  onInviteRoleKeyChange: (value: InviteRoleKey) => void;
  onCreateInvite: () => void;
  onCopyInviteValue: (value: string, label: string) => void;
  onInviteAllowlistDomainsInputChange: (value: string) => void;
  onInviteAllowlistEmailsInputChange: (value: string) => void;
  onRequirePasswordForUnlistedChange: (value: boolean) => void;
  onInviteJoinPasswordInputChange: (value: string) => void;
  onClearInviteJoinPasswordChange: (value: boolean) => void;
  onSaveInviteAccessSettings: () => void;
  onToggleAdminRole: () => void;
};

function AdminMembersSection({ tenantMembers }: { tenantMembers: TenantMember[] }) {
  return (
    <div style={sectionStyle}>
      <h3 style={sectionTitleStyle}>Users In Current Organization</h3>
      {tenantMembers.length === 0 ? (
        <p style={textStyle}>No active users found.</p>
      ) : (
        <ul style={listStyle}>
          {tenantMembers.map((member) => (
            <li key={member.membershipId} style={listItemStyle}>
              <strong>{member.displayName ?? member.email ?? member.userId}</strong>
              {member.email && member.displayName && (
                <span style={{ color: "#888" }}> — {member.email}</span>
              )}{" "}
              | role: {member.roleKey ?? "unknown"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type AdminInviteSectionProps = {
  inviteDescription: string;
  inviteType: InviteType;
  inviteEmailInput: string;
  inviteRoleKey: InviteRoleKey;
  isCreatingInvite: boolean;
  inviteError: string | null;
  inviteStatus: string | null;
  createdInvite: TenantInvite | null;
  onInviteTypeChange: (nextType: InviteType) => void;
  onInviteEmailChange: (value: string) => void;
  onInviteRoleKeyChange: (value: InviteRoleKey) => void;
  onCreateInvite: () => void;
  onCopyInviteValue: (value: string, label: string) => void;
};

function AdminInviteSection({
  inviteDescription,
  inviteType,
  inviteEmailInput,
  inviteRoleKey,
  isCreatingInvite,
  inviteError,
  inviteStatus,
  createdInvite,
  onInviteTypeChange,
  onInviteEmailChange,
  onInviteRoleKeyChange,
  onCreateInvite,
  onCopyInviteValue,
}: AdminInviteSectionProps) {
  const [showFallbackToken, setShowFallbackToken] = useState(false);

  useEffect(() => {
    setShowFallbackToken(false);
  }, [createdInvite?.inviteToken]);

  return (
    <div style={sectionStyle}>
      <h3 style={sectionTitleStyle}>Invite Users</h3>
      <p style={textStyle}>{inviteDescription}</p>
      <div style={modeToggleStyle}>
        <button
          type="button"
          style={
            inviteType === "personalized" ? activeModeButtonStyle : modeButtonStyle
          }
          onClick={() => onInviteTypeChange("personalized")}
        >
          Personalized
        </button>
        <button
          type="button"
          style={inviteType === "shared" ? activeModeButtonStyle : modeButtonStyle}
          onClick={() => onInviteTypeChange("shared")}
        >
          Group (Shared)
        </button>
      </div>
      {inviteType === "personalized" ? (
        <input
          style={inputStyle}
          type="email"
          placeholder="employee@company.com"
          value={inviteEmailInput}
          onChange={(event) => onInviteEmailChange(event.target.value)}
        />
      ) : (
        <p style={textStyle}>
          Group invites do not target a single email and remain reusable.
        </p>
      )}
      {inviteType === "personalized" && (
        <select
          style={inputStyle}
          value={inviteRoleKey}
          onChange={(event) =>
            onInviteRoleKeyChange(event.target.value === "admin" ? "admin" : "member")
          }
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
      )}
      <div style={actionsStyle}>
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={isCreatingInvite}
          onClick={onCreateInvite}
        >
          {isCreatingInvite ? "Creating..." : "Create Invite"}
        </button>
      </div>
      {inviteError && <p style={errorTextStyle}>{inviteError}</p>}
      {inviteStatus && <p style={textStyle}>{inviteStatus}</p>}
      {createdInvite && (
        <div style={inviteResultStyle}>
          {createdInvite.inviteUrl && (
            <p style={tokenTextStyle}>Link: {createdInvite.inviteUrl}</p>
          )}
          {!createdInvite.inviteUrl && (
            <p style={tokenTextStyle}>Token: {createdInvite.inviteToken}</p>
          )}
          <p style={textStyle}>
            Type: {createdInvite.inviteType === "personalized" ? "Personalized" : "Group (Shared)"}{" "}
            | Role: {createdInvite.roleKey} | Expires:{" "}
            {new Date(createdInvite.expiresAt).toLocaleString()}
          </p>
          {!createdInvite.delivery.sent && createdInvite.delivery.errorCode && (
            <p style={textStyle}>Delivery: {createdInvite.delivery.errorCode}</p>
          )}
          <div style={actionsStyle}>
            {createdInvite.inviteUrl && (
              <button
                type="button"
                style={primaryButtonStyle}
                onClick={() => onCopyInviteValue(createdInvite.inviteUrl ?? "", "Link")}
              >
                Copy Link
              </button>
            )}
            {createdInvite.inviteUrl && (
              <button
                type="button"
                style={secondaryButtonStyle}
                onClick={() => setShowFallbackToken((prev) => !prev)}
              >
                {showFallbackToken ? "Hide Fallback Token" : "Show Fallback Token"}
              </button>
            )}
            {!createdInvite.inviteUrl && (
              <button
                type="button"
                style={primaryButtonStyle}
                onClick={() => onCopyInviteValue(createdInvite.inviteToken, "Token")}
              >
                Copy Token
              </button>
            )}
            {showFallbackToken && createdInvite.inviteUrl && (
              <button
                type="button"
                style={secondaryButtonStyle}
                onClick={() => onCopyInviteValue(createdInvite.inviteToken, "Token")}
              >
                Copy Fallback Token
              </button>
            )}
          </div>
          {showFallbackToken && createdInvite.inviteUrl && (
            <p style={tokenTextStyle}>Token: {createdInvite.inviteToken}</p>
          )}
        </div>
      )}
    </div>
  );
}

function DevToolSection({
  isGrantingAdmin,
  isCurrentUserAdmin,
  adminToolStatus,
  onToggleAdminRole,
}: {
  isGrantingAdmin: boolean;
  isCurrentUserAdmin: boolean;
  adminToolStatus: string | null;
  onToggleAdminRole: () => void;
}) {
  return (
    <div style={sectionStyle}>
      <h3 style={sectionTitleStyle}>Dev Tool</h3>
      <button
        type="button"
        style={secondaryButtonStyle}
        disabled={isGrantingAdmin}
        onClick={onToggleAdminRole}
      >
        {isGrantingAdmin
          ? "Updating role..."
          : isCurrentUserAdmin
            ? "Set Me Member"
            : "Set Me Admin"}
      </button>
      {adminToolStatus && <p style={textStyle}>{adminToolStatus}</p>}
    </div>
  );
}

type InviteAccessSettingsSectionProps = {
  inviteType: InviteType;
  canManageInvitePassword: boolean;
  inviteAllowlistDomainsInput: string;
  inviteAllowlistEmailsInput: string;
  requirePasswordForUnlisted: boolean;
  hasInviteJoinPassword: boolean;
  inviteJoinPasswordInput: string;
  clearInviteJoinPassword: boolean;
  isSavingInviteAccess: boolean;
  inviteAccessError: string | null;
  inviteAccessStatus: string | null;
  onInviteAllowlistDomainsInputChange: (value: string) => void;
  onInviteAllowlistEmailsInputChange: (value: string) => void;
  onRequirePasswordForUnlistedChange: (value: boolean) => void;
  onInviteJoinPasswordInputChange: (value: string) => void;
  onClearInviteJoinPasswordChange: (value: boolean) => void;
  onSaveInviteAccessSettings: () => void;
};

function InviteAccessSettingsSection({
  inviteType,
  canManageInvitePassword,
  inviteAllowlistDomainsInput,
  inviteAllowlistEmailsInput,
  requirePasswordForUnlisted,
  hasInviteJoinPassword,
  inviteJoinPasswordInput,
  clearInviteJoinPassword,
  isSavingInviteAccess,
  inviteAccessError,
  inviteAccessStatus,
  onInviteAllowlistDomainsInputChange,
  onInviteAllowlistEmailsInputChange,
  onRequirePasswordForUnlistedChange,
  onInviteJoinPasswordInputChange,
  onClearInviteJoinPasswordChange,
  onSaveInviteAccessSettings,
}: InviteAccessSettingsSectionProps) {
  const [showInvitePassword, setShowInvitePassword] = useState(false);

  return (
    <div style={sectionStyle}>
      <h3 style={sectionTitleStyle}>Invite Access Controls</h3>
      {inviteType !== "shared" ? (
        <p style={textStyle}>
          These controls apply only to Group (Shared) invites. Switch Invite Users
          mode to Group to edit allowlists and password policy.
        </p>
      ) : (
        <>
      <p style={textStyle}>
        Whitelisted emails/domains can join shared invites directly. Others must
        pass the invite password when enforcement is enabled.
      </p>
      <textarea
        style={{ ...inputStyle, minHeight: 76, resize: "vertical" }}
        value={inviteAllowlistDomainsInput}
        onChange={(event) =>
          onInviteAllowlistDomainsInputChange(event.target.value)
        }
        placeholder="Allowed domains (comma or newline separated)\nexample.com\nrevox.io"
      />
      <textarea
        style={{ ...inputStyle, minHeight: 76, resize: "vertical" }}
        value={inviteAllowlistEmailsInput}
        onChange={(event) =>
          onInviteAllowlistEmailsInputChange(event.target.value)
        }
        placeholder="Allowed emails (comma or newline separated)\nadmin@example.com"
      />
      {canManageInvitePassword ? (
        <label style={textStyle}>
          <input
            type="checkbox"
            checked={requirePasswordForUnlisted}
            onChange={(event) =>
              onRequirePasswordForUnlistedChange(event.target.checked)
            }
            style={{ marginRight: 8 }}
          />
          Require password for non-whitelisted shared-invite joins
        </label>
      ) : (
        <p style={textStyle}>
          Password requirement:{" "}
          {requirePasswordForUnlisted ? "Enabled" : "Disabled"}. Only organization
          owners can change this setting.
        </p>
      )}
      <p style={textStyle}>
        Password status: {hasInviteJoinPassword ? "Configured" : "Not configured"}
      </p>
      {canManageInvitePassword ? (
        <>
          <input
            style={inputStyle}
            type={showInvitePassword ? "text" : "password"}
            value={inviteJoinPasswordInput}
            onChange={(event) => onInviteJoinPasswordInputChange(event.target.value)}
            placeholder="Set new invite password (min 8 chars)"
            autoComplete="new-password"
            disabled={clearInviteJoinPassword}
          />
          <label style={textStyle}>
            <input
              type="checkbox"
              checked={showInvitePassword}
              onChange={(event) => setShowInvitePassword(event.target.checked)}
              style={{ marginRight: 8 }}
            />
            Show password
          </label>
          {hasInviteJoinPassword && (
            <label style={textStyle}>
              <input
                type="checkbox"
                checked={clearInviteJoinPassword}
                onChange={(event) =>
                  onClearInviteJoinPasswordChange(event.target.checked)
                }
                style={{ marginRight: 8 }}
              />
              Clear existing invite password
            </label>
          )}
        </>
      ) : (
        <p style={textStyle}>Only organization owners can set or clear invite passwords.</p>
      )}
      {inviteAccessError && <p style={errorTextStyle}>{inviteAccessError}</p>}
      {inviteAccessStatus && <p style={textStyle}>{inviteAccessStatus}</p>}
      <div style={actionsStyle}>
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={isSavingInviteAccess}
          onClick={onSaveInviteAccessSettings}
        >
          {isSavingInviteAccess ? "Saving..." : "Save Invite Access"}
        </button>
      </div>
        </>
      )}
    </div>
  );
}

export function TenantDashboardView({
  tenantName,
  tenantSlug,
  currentRoleKey,
  dashboardError,
  isDashboardLoading,
  isSigningOut,
  canAccessAdminDashboard,
  isCurrentUserAdmin,
  canCreateInvites,
  canManageInviteAccess,
  canManageInvitePassword,
  tenantMembers,
  inviteDescription,
  inviteType,
  inviteEmailInput,
  inviteRoleKey,
  isCreatingInvite,
  inviteError,
  inviteStatus,
  createdInvite,
  inviteAllowlistDomainsInput,
  inviteAllowlistEmailsInput,
  requirePasswordForUnlisted,
  hasInviteJoinPassword,
  inviteJoinPasswordInput,
  clearInviteJoinPassword,
  isSavingInviteAccess,
  inviteAccessError,
  inviteAccessStatus,
  showDevTool,
  isGrantingAdmin,
  adminToolStatus,
  onEnterGame,
  onRefresh,
  onSignOut,
  onInviteTypeChange,
  onInviteEmailChange,
  onInviteRoleKeyChange,
  onCreateInvite,
  onCopyInviteValue,
  onInviteAllowlistDomainsInputChange,
  onInviteAllowlistEmailsInputChange,
  onRequirePasswordForUnlistedChange,
  onInviteJoinPasswordInputChange,
  onClearInviteJoinPasswordChange,
  onSaveInviteAccessSettings,
  onToggleAdminRole,
}: TenantDashboardViewProps) {
  return (
    <div style={pageStyle}>
      <div style={orgDashboardScrollStyle}>
        <div style={orgDashboardCardStyle}>
          <h2 style={titleStyle}>Organization Dashboard</h2>
          <p style={textStyle}>
            Tenant: {tenantName} | Role: {currentRoleKey ?? "none"}
          </p>
          {dashboardError && <p style={errorTextStyle}>{dashboardError}</p>}
          {isDashboardLoading && (
            <p style={textStyle}>Loading organizations and users...</p>
          )}
          <div style={actionsStyle}>
            <button type="button" style={primaryButtonStyle} onClick={onEnterGame}>
              Enter Game
            </button>
            <button type="button" style={secondaryButtonStyle} onClick={onRefresh}>
              Refresh
            </button>
            <button type="button" style={secondaryButtonStyle} onClick={onSignOut}>
              {isSigningOut ? "Signing out..." : "Log out"}
            </button>
          </div>

          {canAccessAdminDashboard && tenantSlug && (
            <div style={sectionStyle}>
              <h3 style={sectionTitleStyle}>Organization</h3>
              <p style={textStyle}>
                <strong>{tenantName}</strong> ({tenantSlug}) | role:{" "}
                {currentRoleKey ?? "unknown"}
              </p>
            </div>
          )}

          {isCurrentUserAdmin && (
            <AdminMembersSection tenantMembers={tenantMembers} />
          )}

          {canCreateInvites && (
            <AdminInviteSection
              inviteDescription={inviteDescription}
              inviteType={inviteType}
              inviteEmailInput={inviteEmailInput}
              inviteRoleKey={inviteRoleKey}
              isCreatingInvite={isCreatingInvite}
              inviteError={inviteError}
              inviteStatus={inviteStatus}
              createdInvite={createdInvite}
              onInviteTypeChange={onInviteTypeChange}
              onInviteEmailChange={onInviteEmailChange}
              onInviteRoleKeyChange={onInviteRoleKeyChange}
              onCreateInvite={onCreateInvite}
              onCopyInviteValue={onCopyInviteValue}
            />
          )}

          {canManageInviteAccess && (
            <InviteAccessSettingsSection
              inviteType={inviteType}
              canManageInvitePassword={canManageInvitePassword}
              inviteAllowlistDomainsInput={inviteAllowlistDomainsInput}
              inviteAllowlistEmailsInput={inviteAllowlistEmailsInput}
              requirePasswordForUnlisted={requirePasswordForUnlisted}
              hasInviteJoinPassword={hasInviteJoinPassword}
              inviteJoinPasswordInput={inviteJoinPasswordInput}
              clearInviteJoinPassword={clearInviteJoinPassword}
              isSavingInviteAccess={isSavingInviteAccess}
              inviteAccessError={inviteAccessError}
              inviteAccessStatus={inviteAccessStatus}
              onInviteAllowlistDomainsInputChange={
                onInviteAllowlistDomainsInputChange
              }
              onInviteAllowlistEmailsInputChange={
                onInviteAllowlistEmailsInputChange
              }
              onRequirePasswordForUnlistedChange={
                onRequirePasswordForUnlistedChange
              }
              onInviteJoinPasswordInputChange={onInviteJoinPasswordInputChange}
              onClearInviteJoinPasswordChange={onClearInviteJoinPasswordChange}
              onSaveInviteAccessSettings={onSaveInviteAccessSettings}
            />
          )}

          {showDevTool && (
            <DevToolSection
              isGrantingAdmin={isGrantingAdmin}
              isCurrentUserAdmin={isCurrentUserAdmin}
              adminToolStatus={adminToolStatus}
              onToggleAdminRole={onToggleAdminRole}
            />
          )}
        </div>
      </div>
    </div>
  );
}
