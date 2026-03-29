import type { LdtkEntityInstance } from "../../../types/mapTypes";

/** Reads LDtk pivot, defaulting to top-left when omitted. */
function getPivot(entity: LdtkEntityInstance) {
  const [pivotX = 0, pivotY = 0] = entity.__pivot ?? [0, 0];
  return { pivotX, pivotY };
}

/** Converts LDtk entity pivot position into top-left world coordinates. */
export function getEntityTopLeft(entity: LdtkEntityInstance) {
  const { pivotX, pivotY } = getPivot(entity);
  return {
    x: entity.px[0] - entity.width * pivotX,
    y: entity.px[1] - entity.height * pivotY,
  };
}

/** Returns the visual center point of the entity bounds in world space. */
export function getEntityCenter(entity: LdtkEntityInstance) {
  const topLeft = getEntityTopLeft(entity);
  return {
    x: topLeft.x + entity.width / 2,
    y: topLeft.y + entity.height / 2,
  };
}
