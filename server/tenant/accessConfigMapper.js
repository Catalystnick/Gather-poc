export function toClientTenantAccessConfig(accessConfig) {
  if (!accessConfig) return null
  return {
    guestZoneEnforced: !!accessConfig.guest_zone_enforced,
    guestCanChat: !!accessConfig.guest_can_chat,
    guestCanTag: !!accessConfig.guest_can_tag,
    guestCanTeleport: !!accessConfig.guest_can_teleport,
    memberCanTag: !!accessConfig.member_can_tag,
    memberCanTeleport: !!accessConfig.member_can_teleport,
    updatedBy: accessConfig.updated_by ?? null,
    updatedAt: accessConfig.updated_at ?? null,
  }
}

function normalizeTextArray(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim().toLowerCase() : ''))
    .filter(Boolean)
}

export function toClientTenantInviteAccessConfig(accessConfig) {
  if (!accessConfig) return null
  return {
    allowlistDomains: normalizeTextArray(accessConfig.invite_allowlist_domains),
    allowlistEmails: normalizeTextArray(accessConfig.invite_allowlist_emails),
    requirePasswordForUnlisted: !!accessConfig.invite_require_password_for_unlisted,
    hasPassword: typeof accessConfig.invite_password_hash === 'string' && accessConfig.invite_password_hash.length > 0,
    updatedBy: accessConfig.updated_by ?? null,
    updatedAt: accessConfig.updated_at ?? null,
  }
}
