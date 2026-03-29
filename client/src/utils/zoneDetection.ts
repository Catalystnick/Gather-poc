import type { Zone } from '../types/mapTypes'

/**
 * Returns the zone key if (worldX, worldY) falls inside any zone rectangle,
 * or null when the position is outside all zones.
 *
 * Called on every tick of the zone-detection interval in useVoice — keep it O(n).
 */
export function getZoneKey(worldX: number, worldY: number, zones: Zone[]): string | null {
  for (const zone of zones) {
    if (
      worldX >= zone.minX && worldX <= zone.maxX &&
      worldY >= zone.minY && worldY <= zone.maxY
    ) {
      return zone.key
    }
  }
  return null
}
