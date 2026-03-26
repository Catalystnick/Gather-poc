// Zone detection utilities — called each position tick (setInterval / useFrame).
// Both functions are O(zones) AABB checks — negligible cost at 3 zones.

import { WORLD_ZONES } from '../data/worldMap'
import { ZONE_PREFETCH_TRIGGERS } from '../data/worldMap'

/**
 * Returns the zoneKey if (x, z) is inside a zone's AABB, otherwise null.
 * Uses WORLD_ZONES which store (center x, center z, width, depth).
 */
export function getZoneKey(x: number, z: number): string | null {
  const zone = WORLD_ZONES.find(
    zn =>
      Math.abs(x - zn.x) <= zn.width / 2 &&
      Math.abs(z - zn.z) <= zn.depth / 2,
  )
  return zone?.key ?? null
}

/**
 * Returns the zoneKey if (x, z) is inside a prefetch trigger zone, otherwise null.
 * Trigger zones are narrow AABB strips just outside each entrance —
 * entering one means the player is approaching that zone and we should
 * pre-fetch its LiveKit token to avoid an audio gap on entry.
 */
export function getPrefetchZoneKey(x: number, z: number): string | null {
  const trigger = ZONE_PREFETCH_TRIGGERS.find(
    t => x >= t.xMin && x <= t.xMax && z >= t.zMin && z <= t.zMax,
  )
  return trigger?.zoneKey ?? null
}
