import Phaser from "phaser";
import type { LdtkMapData } from "../../../../types/mapTypes";
import { TILE_PX } from "../../../engine/constants";

function loadTileSheet(scene: Phaser.Scene, key: string, path: string) {
  scene.load.spritesheet(key, path, {
    frameWidth: TILE_PX,
    frameHeight: TILE_PX,
  });
}

function loadPlayerSheet(scene: Phaser.Scene, key: string, path: string) {
  scene.load.spritesheet(key, path, { frameWidth: 64, frameHeight: 64 });
}

function preloadFallbackTilesets(scene: Phaser.Scene) {
  const atlasPath = (name: string) =>
    `/sprite%20sheet%20atlases/${encodeURIComponent(name)}`;
  loadTileSheet(scene, "ts-house-tiles", atlasPath("house atlas sheet.png"));
  loadTileSheet(scene, "ts-graveyard-tiles", atlasPath("graveyard atlas.png"));
  loadTileSheet(scene, "ts-boxes", atlasPath("boxes atlas.png"));
  loadTileSheet(scene, "ts-tents", atlasPath("tent atlas.png"));
  loadTileSheet(scene, "ts-fences", atlasPath("Tileset2.png"));
  loadTileSheet(scene, "ts-plant", atlasPath("TX_Plant.png"));
  loadTileSheet(scene, "ts-grass-tiles", atlasPath("TX_Tileset_Grass.png"));
  loadTileSheet(
    scene,
    "ts-dev-trader-dialogue",
    "/sprite%20sheet%20atlases/Dev%20trader/Dialogue.png",
  );
  loadTileSheet(
    scene,
    "ts-design-trader-dialogue",
    "/sprite%20sheet%20atlases/Design%20trader/Dialogue.png",
  );
  loadTileSheet(
    scene,
    "ts-game-trader-dialogue",
    "/sprite%20sheet%20atlases/Game%20trader/Dialogue.png",
  );
}

/** Normalize LDtk relPath values into public URL paths with encoded spaces. */
function normalizeLdtkRelPath(relPath: string) {
  const forwardSlashes = relPath.replace(/\\/g, "/");
  const withoutPublicPrefix = forwardSlashes.replace(
    /^\.?\/?(public\/)?/i,
    "",
  );
  const withLeadingSlash = withoutPublicPrefix.startsWith("/")
    ? withoutPublicPrefix
    : `/${withoutPublicPrefix}`;
  return encodeURI(withLeadingSlash);
}

/** Preload all scene textures used by map, entities, and avatars. */
export function preloadSceneAssets(scene: Phaser.Scene, mapData: LdtkMapData | null) {
  const hasDynamicTilesets = !!mapData && mapData.tilesetDefs.size > 0;
  if (hasDynamicTilesets) {
    for (const [uid, tilesetDef] of mapData!.tilesetDefs) {
      if (!tilesetDef.relPath) continue;
      const textureKey = mapData!.tilesetTextureKeys.get(uid);
      if (!textureKey) continue;
      loadTileSheet(scene, textureKey, normalizeLdtkRelPath(tilesetDef.relPath));
    }
  } else {
    preloadFallbackTilesets(scene);
  }

  loadTileSheet(
    scene,
    "ts-dev-trader-idle-1",
    "/sprite%20sheet%20atlases/Dev%20trader/Idle.png",
  );
  loadTileSheet(
    scene,
    "ts-dev-trader-idle-2",
    "/sprite%20sheet%20atlases/Dev%20trader/Idle_2.png",
  );
  loadTileSheet(
    scene,
    "ts-dev-trader-idle-3",
    "/sprite%20sheet%20atlases/Dev%20trader/Idle_3.png",
  );
  loadTileSheet(
    scene,
    "ts-design-trader-idle-1",
    "/sprite%20sheet%20atlases/Design%20trader/Idle.png",
  );
  loadTileSheet(
    scene,
    "ts-design-trader-idle-2",
    "/sprite%20sheet%20atlases/Design%20trader/Idle_2.png",
  );
  loadTileSheet(
    scene,
    "ts-design-trader-idle-3",
    "/sprite%20sheet%20atlases/Design%20trader/Idle_3.png",
  );
  loadTileSheet(
    scene,
    "ts-game-trader-idle-1",
    "/sprite%20sheet%20atlases/Game%20trader/Idle.png",
  );
  loadTileSheet(
    scene,
    "ts-game-trader-idle-2",
    "/sprite%20sheet%20atlases/Game%20trader/Idle_2.png",
  );
  loadTileSheet(
    scene,
    "ts-game-trader-idle-3",
    "/sprite%20sheet%20atlases/Game%20trader/Idle_3.png",
  );

  loadPlayerSheet(scene, "p-template", "/avatars/template.png");
  loadPlayerSheet(scene, "p-shoes", "/avatars/shoes.png");
  loadPlayerSheet(scene, "p-shirt", "/avatars/shirt.png");

  scene.load.image("lochlin", "/lochlin.jpeg");
}

/** Keep pixel-art textures sharp by disabling linear filtering. */
export function applyNearestTextureFilters(
  scene: Phaser.Scene,
  mapData: LdtkMapData | null,
) {
  const keys = new Set<string>([
    ...(mapData ? Array.from(mapData.tilesetTextureKeys.values()) : []),
    "ts-dev-trader-idle-1",
    "ts-dev-trader-idle-2",
    "ts-dev-trader-idle-3",
    "ts-design-trader-idle-1",
    "ts-design-trader-idle-2",
    "ts-design-trader-idle-3",
    "ts-game-trader-idle-1",
    "ts-game-trader-idle-2",
    "ts-game-trader-idle-3",
    "p-template",
    "p-shoes",
    "p-shirt",
    "lochlin",
  ]);

  keys.forEach((key) => {
    const texture = scene.textures.get(key);
    if (texture) texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
  });
}
