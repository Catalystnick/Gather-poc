export type OnboardingMode = "create" | "invite";

export type InviteRoleKey = "member" | "admin";

export type InviteType = "personalized" | "shared";

export type TenantMember = {
  membershipId: string;
  userId: string;
  email: string | null;
  displayName: string | null;
  roleKey: string | null;
};

export type InviteDelivery = {
  attempted: boolean;
  sent: boolean;
  provider: string;
  errorCode?: string | null;
};

export type TenantInvite = {
  tenantId: string;
  inviteToken: string;
  inviteUrl: string | null;
  inviteType: InviteType;
  roleKey: string;
  inviteEmail: string | null;
  expiresAt: string;
  delivery: InviteDelivery;
};
