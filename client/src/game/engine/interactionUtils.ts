import type { LdtkEntityInstance } from "../../types/mapTypes";

/** Read a string field from an LDtk entity by identifier. */
export function getEntityStringField(
  entity: LdtkEntityInstance,
  fieldIdentifier: string,
) {
  const field = entity.fieldInstances.find(
    (fieldInstance) => fieldInstance.__identifier === fieldIdentifier,
  );
  return typeof field?.__value === "string" ? field.__value.trim() : "";
}

/** Return the first non-empty string among a list of LDtk field identifiers. */
export function getFirstEntityStringField(
  entity: LdtkEntityInstance,
  fieldIdentifiers: string[],
) {
  for (const fieldIdentifier of fieldIdentifiers) {
    const value = getEntityStringField(entity, fieldIdentifier);
    if (value) return value;
  }
  return "";
}

/** Find nearest item with x/y coordinates to player world position. */
export function findNearestPoint<T extends { x: number; y: number }>(
  items: T[],
  playerPosition: { x: number; y: number },
) {
  let nearest: T | null = null;
  let nearestSq = Number.POSITIVE_INFINITY;

  for (const item of items) {
    const dx = item.x - playerPosition.x;
    const dy = item.y - playerPosition.y;
    const sq = dx * dx + dy * dy;
    if (sq < nearestSq) {
      nearestSq = sq;
      nearest = item;
    }
  }

  return nearest ? { item: nearest, sq: nearestSq } : null;
}
