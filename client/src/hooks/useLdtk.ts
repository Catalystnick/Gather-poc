import { useState, useEffect } from 'react';
import type { LdtkProject, LdtkMapData } from '../types/mapTypes';

const GRID_SIZE = 16;

/** Normalize LDtk zone entity names into stable zone keys (e.g. "Dev_zone_trigger" -> "dev"). */
function zoneKey(identifier: string): string {
  // "Dev_zone_trigger" → "dev", "Game_Zone_Trigger" → "game"
  return identifier
    .replace(/_?(zone|Zone)_?(trigger|Trigger)/g, '')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

/** Parse the LDtk project into runtime map data used by Phaser and voice systems. */
function parse(raw: LdtkProject): LdtkMapData {
  if (!raw?.levels?.length) {
    throw new Error('LDtk parse error: project has no levels')
  }

  const level = raw.levels[0];
  const layers = level.layerInstances ?? [];

  const tilesetDefs = new Map(raw.defs.tilesets.map((tileset) => [tileset.uid, tileset]));

  const collisionLayer = layers.find((layer) => layer.__identifier === 'Collision_grid');
  const collisionCsv = collisionLayer?.intGridCsv ?? [];
  const gridWidth  = collisionLayer?.__cWid  ?? 60;
  const gridHeight = collisionLayer?.__cHei ?? 60;

  // Extract voice zones from entity instances named *zone*
  const zones = layers
    .flatMap((layer) => layer.entityInstances)
    .filter((entity) => entity.__identifier.toLowerCase().includes('zone'))
    .map((entity) => ({
      key:  zoneKey(entity.__identifier),
      minX: entity.px[0] / GRID_SIZE,
      maxX: (entity.px[0] + entity.width)  / GRID_SIZE - 1,
      minY: entity.px[1] / GRID_SIZE,
      maxY: (entity.px[1] + entity.height) / GRID_SIZE - 1,
    }));

  // Walkable tiles in the server's central spawn zone (cols 27–33, rows 27–33)
  const spawnCandidates: Array<{ col: number; row: number }> = [];
  for (let row = 27; row <= 33; row++) {
    for (let col = 27; col <= 33; col++) {
      if ((collisionCsv[row * gridWidth + col] ?? 0) === 0) {
        spawnCandidates.push({ col, row });
      }
    }
  }

  return {
    level,
    tilesetDefs,
    collisionCsv,
    gridWidth,
    gridHeight,
    zones,
    spawnCandidates: spawnCandidates.length > 0 ? spawnCandidates : [{ col: 30, row: 30 }],
  };
}

/** Load and cache LDtk map data for the active world. */
export function useLdtk() {
  const [mapData,  setMapData]  = useState<LdtkMapData | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setMapError(null);

    fetch('/test.ldtk', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<LdtkProject>;
      })
      .then(raw => setMapData(parse(raw)))
      .catch((error)  => {
        if ((error as Error).name === 'AbortError') return;
        setMapError(String(error));
      });

    return () => controller.abort();
  }, []);

  return { mapData, mapError };
}
