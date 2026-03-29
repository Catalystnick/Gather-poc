import { useState, useEffect } from 'react';
import type { LdtkProject, LdtkMapData } from '../types/mapTypes';

const GRID_SIZE = 16;

/** Convert an entity's pivot-space position to top-left world pixel position. */
function entityTopLeft(entity: {
  px: [number, number];
  width: number;
  height: number;
  __pivot?: [number, number];
}) {
  const pivot = entity.__pivot ?? [0, 0];
  return {
    x: entity.px[0] - pivot[0] * entity.width,
    y: entity.px[1] - pivot[1] * entity.height,
  };
}

/** Convert an LDtk tileset identifier into a stable Phaser texture key. */
function tilesetTextureKey(identifier: string): string {
  return `ts-${identifier.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/** Normalize LDtk zone entity names into stable zone keys (e.g. "Dev_zone_trigger" -> "dev"). */
function zoneKey(identifier: string): string {
  return identifier
    .replace(/_?(zone|Zone)_?(trigger|Trigger)/g, '')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

/** Parse the LDtk project into runtime map data used by Phaser and voice systems. */
function parse(raw: LdtkProject): LdtkMapData {
  if (!raw?.levels?.length) {
    throw new Error('LDtk parse error: project has no levels');
  }

  const level = raw.levels[0];
  const layers = level.layerInstances ?? [];

  const tilesetDefs = new Map(raw.defs.tilesets.map((tileset) => [tileset.uid, tileset]));
  const tilesetTextureKeys = new Map(
    raw.defs.tilesets.map((tileset) => [
      tileset.uid,
      tilesetTextureKey(tileset.identifier),
    ]),
  );

  const collisionLayer = layers.find((layer) => layer.__identifier === 'Collision_grid');
  const collisionCsv = collisionLayer?.intGridCsv ?? [];
  const gridWidth = collisionLayer?.__cWid ?? 60;
  const gridHeight = collisionLayer?.__cHei ?? 60;

  // Extract voice zones from entity instances named *zone*.
  const zones = layers
    .flatMap((layer) => layer.entityInstances)
    .filter((entity) => entity.__identifier.toLowerCase().includes('zone'))
    .map((entity) => ({
      key: zoneKey(entity.__identifier),
      minX: entity.px[0] / GRID_SIZE,
      maxX: (entity.px[0] + entity.width) / GRID_SIZE - 1,
      minY: entity.px[1] / GRID_SIZE,
      maxY: (entity.px[1] + entity.height) / GRID_SIZE - 1,
    }));

  // Exclude tiles occupied by visual entities from random spawn candidates.
  const occupiedSpawnTiles = new Set<string>();
  for (const layer of layers) {
    for (const entity of layer.entityInstances) {
      if (!entity.__tile) continue;
      if (entity.__identifier.toLowerCase().includes('zone')) continue;

      const topLeft = entityTopLeft(entity);
      const minCol = Math.floor(topLeft.x / GRID_SIZE);
      const minRow = Math.floor(topLeft.y / GRID_SIZE);
      const maxColExclusive = Math.ceil((topLeft.x + entity.width) / GRID_SIZE);
      const maxRowExclusive = Math.ceil((topLeft.y + entity.height) / GRID_SIZE);

      for (let row = minRow; row < maxRowExclusive; row++) {
        for (let col = minCol; col < maxColExclusive; col++) {
          occupiedSpawnTiles.add(`${col},${row}`);
        }
      }
    }
  }

  // Walkable tiles in the server's central spawn zone (cols 27-33, rows 27-33).
  const spawnCandidates: Array<{ col: number; row: number }> = [];
  for (let row = 27; row <= 33; row++) {
    for (let col = 27; col <= 33; col++) {
      const isWalkable = (collisionCsv[row * gridWidth + col] ?? 0) === 0;
      const isOccupied = occupiedSpawnTiles.has(`${col},${row}`);
      if (isWalkable && !isOccupied) {
        spawnCandidates.push({ col, row });
      }
    }
  }

  return {
    level,
    tilesetDefs,
    tilesetTextureKeys,
    collisionCsv,
    gridWidth,
    gridHeight,
    zones,
    spawnCandidates: spawnCandidates.length > 0 ? spawnCandidates : [{ col: 30, row: 30 }],
  };
}

/** Load and cache LDtk map data for the active world. */
export function useLdtk() {
  const [mapData, setMapData] = useState<LdtkMapData | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setMapError(null);

    fetch('/test.ldtk', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<LdtkProject>;
      })
      .then((raw) => setMapData(parse(raw)))
      .catch((error) => {
        if ((error as Error).name === 'AbortError') return;
        setMapError(String(error));
      });

    return () => controller.abort();
  }, []);

  return { mapData, mapError };
}
