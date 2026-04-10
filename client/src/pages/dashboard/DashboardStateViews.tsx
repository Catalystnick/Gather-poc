import type { OnboardingMode } from "./dashboardTypes";
import {
  actionsStyle,
  activeModeButtonStyle,
  cardStyle,
  errorTextStyle,
  inputStyle,
  modeButtonStyle,
  modeToggleStyle,
  pageStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
  textStyle,
  titleStyle,
} from "./dashboardStyles";

type DashboardLoadingViewProps = {
  message: string;
};

export function DashboardLoadingView({ message }: DashboardLoadingViewProps) {
  return (
    <div style={pageStyle}>
      <div style={cardStyle}>{message}</div>
    </div>
  );
}

type DashboardErrorViewProps = {
  error: string;
  onRetry: () => void;
  onSignOut: () => void;
};

export function DashboardErrorView({
  error,
  onRetry,
  onSignOut,
}: DashboardErrorViewProps) {
  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        <h2 style={titleStyle}>Dashboard Error</h2>
        <p style={textStyle}>{error}</p>
        <div style={actionsStyle}>
          <button type="button" style={primaryButtonStyle} onClick={onRetry}>
            Retry
          </button>
          <button type="button" style={secondaryButtonStyle} onClick={onSignOut}>
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}

type InviteAutoJoinViewProps = {
  isSubmitting: boolean;
  error: string | null;
  onRetry: () => void;
  onSignOut: () => void;
};

export function InviteAutoJoinView({
  isSubmitting,
  error,
  onRetry,
  onSignOut,
}: InviteAutoJoinViewProps) {
  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        <h2 style={titleStyle}>Joining Organization</h2>
        <p style={textStyle}>
          Processing invite link and joining your organization...
        </p>
        {isSubmitting && <p style={textStyle}>Joining with invite...</p>}
        {error && <p style={errorTextStyle}>{error}</p>}
        <div style={actionsStyle}>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={isSubmitting}
            onClick={onRetry}
          >
            {isSubmitting ? "Joining..." : "Retry Join"}
          </button>
          <button type="button" style={secondaryButtonStyle} onClick={onSignOut}>
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}

type OnboardingViewProps = {
  mode: OnboardingMode;
  tenantNameInput: string;
  inviteTokenInput: string;
  isSubmitting: boolean;
  error: string | null;
  onModeChange: (nextMode: OnboardingMode) => void;
  onTenantNameChange: (value: string) => void;
  onInviteTokenChange: (value: string) => void;
  onSubmit: () => void;
  onSignOut: () => void;
};

export function OnboardingView({
  mode,
  tenantNameInput,
  inviteTokenInput,
  isSubmitting,
  error,
  onModeChange,
  onTenantNameChange,
  onInviteTokenChange,
  onSubmit,
  onSignOut,
}: OnboardingViewProps) {
  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        <h2 style={titleStyle}>Set Up Your Organization</h2>
        <p style={textStyle}>
          Create an organization or join with an invite token before entering
          the game.
        </p>
        <div style={modeToggleStyle}>
          <button
            type="button"
            style={mode === "create" ? activeModeButtonStyle : modeButtonStyle}
            onClick={() => onModeChange("create")}
          >
            Create Organization
          </button>
          <button
            type="button"
            style={mode === "invite" ? activeModeButtonStyle : modeButtonStyle}
            onClick={() => onModeChange("invite")}
          >
            Join Invite
          </button>
        </div>
        {mode === "create" ? (
          <input
            style={inputStyle}
            type="text"
            value={tenantNameInput}
            onChange={(event) => onTenantNameChange(event.target.value)}
            placeholder="Organization name"
          />
        ) : (
          <input
            style={inputStyle}
            type="text"
            value={inviteTokenInput}
            onChange={(event) => onInviteTokenChange(event.target.value)}
            placeholder="Invite token"
          />
        )}
        {error && <p style={errorTextStyle}>{error}</p>}
        <div style={actionsStyle}>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={isSubmitting}
            onClick={onSubmit}
          >
            {isSubmitting ? "Submitting..." : "Continue"}
          </button>
          <button type="button" style={secondaryButtonStyle} onClick={onSignOut}>
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}
