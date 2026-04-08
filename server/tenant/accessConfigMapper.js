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
