import { useRef, useLayoutEffect } from "react";
import { useFrame } from "@react-three/fiber";
import { useKeyboardControls } from "@react-three/drei";
import type { Group } from "three";
import AvatarMesh, { SPRITE_ANCHOR_Z } from "./AvatarMesh";
import PlayerLabel from "./PlayerLabel";
import StatusRing from "./StatusRing";
import type { Direction, Player } from "../../types";
import { tileToWorld } from "../../utils/gridHelpers";
import { canMove } from "../../utils/tileMap";

// Seconds to tween between two tile centres.
const TWEEN_DURATION = 0.15
// Seconds of hold before auto-walk begins (Pokémon-style initial delay).
const HOLD_DELAY = 0.2
// Seconds between auto-walk steps while a key is held.
const STEP_INTERVAL = 0.15

interface Props {
  player: Player;
  onMove: (state: { col: number; row: number; direction: Direction; moving: boolean; zoneKey: string | null }) => void;
  positionRef: React.MutableRefObject<{ x: number; y: number; z: number }>;
  spawnPosition: { col: number; row: number };
  isSpeaking?: boolean;
  activeZoneKey: string | null;
}

export default function LocalPlayer({ player, onMove, positionRef, spawnPosition, isSpeaking, activeZoneKey }: Props) {
  const ref = useRef<Group>(null);
  const [, getKeys] = useKeyboardControls();

  // Animation state — read by AvatarMesh each frame.
  const directionRef = useRef<Direction>("down");
  const isMovingRef = useRef(false);

  // Grid state — committed tile position.
  const gridColRef = useRef(spawnPosition.col);
  const gridRowRef = useRef(spawnPosition.row);

  // Tween state.
  const isTweeningRef = useRef(false);
  const tweenProgressRef = useRef(0);
  const tweenFromXRef = useRef(0);
  const tweenFromZRef = useRef(0);
  const tweenToXRef = useRef(0);
  const tweenToZRef = useRef(0);
  const tweenToColRef = useRef(spawnPosition.col);
  const tweenToRowRef = useRef(spawnPosition.row);
  // Linear during continuous movement (hold / buffered chain) so the character
  // moves at a constant speed. Smoothstep only for an isolated single tap.
  const tweenLinearRef = useRef(false);

  // Input state — track direction changes to implement hold-to-walk timing.
  const prevActiveDirRef = useRef<Direction | null>(null);
  const justPressedRef = useRef(false);
  const holdTimerRef = useRef(0);
  const stepAccRef = useRef(0);
  const bufferedDirRef = useRef<Direction | null>(null);

  // Zone and emit state.
  const activeZoneKeyRef = useRef(activeZoneKey);
  activeZoneKeyRef.current = activeZoneKey;

  // Place mesh at spawn tile before first frame.
  // Also cancels any in-flight tween from a previous session (e.g. socket
  // reconnect assigns a new spawn tile while the old tween is still running —
  // without this reset the tween would complete and overwrite gridColRef with
  // the pre-reconnect target, producing a large dist on the server).
  useLayoutEffect(() => {
    if (!ref.current) return;
    const { x, z } = tileToWorld(spawnPosition.col, spawnPosition.row);
    ref.current.position.set(x, 0.5, z);
    gridColRef.current      = spawnPosition.col;
    gridRowRef.current      = spawnPosition.row;
    positionRef.current     = { x, y: 0.5, z };
    isTweeningRef.current   = false;
    tweenProgressRef.current = 0;
    tweenFromXRef.current   = x;
    tweenFromZRef.current   = z;
    tweenToXRef.current     = x;
    tweenToZRef.current     = z;
    tweenToColRef.current   = spawnPosition.col;
    tweenToRowRef.current   = spawnPosition.row;
    bufferedDirRef.current  = null;
    justPressedRef.current  = false;
    holdTimerRef.current    = 0;
    stepAccRef.current      = 0;
  }, [spawnPosition]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((_, delta) => {
    if (!ref.current) return;

    // Suppress movement while typing.
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    const { forward, backward, left, right } = getKeys();

    // Resolve the active direction — exactly one key must be pressed.
    // Two or more keys held simultaneously blocks movement entirely.
    const heldCount = (forward ? 1 : 0) + (backward ? 1 : 0) + (left ? 1 : 0) + (right ? 1 : 0);
    const activeDir: Direction | null =
      heldCount !== 1 ? null
      : forward  ? "up"
      : backward ? "down"
      : left     ? "left"
      : "right";

    // Detect direction changes to reset hold timing.
    if (activeDir !== prevActiveDirRef.current) {
      prevActiveDirRef.current = activeDir;
      holdTimerRef.current = 0;
      stepAccRef.current = 0;
      justPressedRef.current = activeDir !== null;
      if (activeDir !== null) directionRef.current = activeDir;
    }

    // Buffer input while a tween is in flight.
    if (isTweeningRef.current && activeDir !== null) {
      bufferedDirRef.current = activeDir;
    }

    // ── Advance tween ────────────────────────────────────────────────────────
    if (isTweeningRef.current) {
      tweenProgressRef.current += delta / TWEEN_DURATION;

      if (tweenProgressRef.current >= 1) {
        // Tween complete — commit to target tile.
        tweenProgressRef.current = 1;
        isTweeningRef.current = false;
        isMovingRef.current = false;
        gridColRef.current = tweenToColRef.current;
        gridRowRef.current = tweenToRowRef.current;

        // Snap mesh to exact tile centre.
        const { x, z } = tileToWorld(gridColRef.current, gridRowRef.current);
        ref.current.position.x = x;
        ref.current.position.z = z;

        // Emit idle state.
        onMove({ col: gridColRef.current, row: gridRowRef.current, direction: directionRef.current, moving: false, zoneKey: activeZoneKeyRef.current });

        // Consume buffered input — only if the same direction is still held.
        const buf = bufferedDirRef.current;
        bufferedDirRef.current = null;
        if (buf !== null && buf === prevActiveDirRef.current) {
          attemptStep(buf, true);
        }
      } else {
        const t = tweenProgressRef.current;
        // Linear for continuous movement (hold / chained steps) — constant speed
        // avoids the rhythmic stutter that smoothstep causes at each tile boundary.
        // Smoothstep only for a single isolated tap where the polish is noticeable.
        const eased = tweenLinearRef.current ? t : t * t * (3 - 2 * t);
        ref.current.position.x = tweenFromXRef.current + (tweenToXRef.current - tweenFromXRef.current) * eased;
        ref.current.position.z = tweenFromZRef.current + (tweenToZRef.current - tweenFromZRef.current) * eased;
      }
    } else {
      // ── Idle — handle step initiation ──────────────────────────────────────
      if (activeDir !== null) {
        holdTimerRef.current += delta;

        if (justPressedRef.current) {
          justPressedRef.current = false;
          attemptStep(activeDir, false);
        } else if (holdTimerRef.current >= HOLD_DELAY) {
          stepAccRef.current += delta;
          if (stepAccRef.current >= STEP_INTERVAL) {
            stepAccRef.current -= STEP_INTERVAL;
            attemptStep(activeDir, true);
          }
        }
      } else {
        stepAccRef.current = 0;
      }
    }

    // Sync world position to positionRef (used by camera and voice proximity).
    const { x, y, z } = ref.current.position;
    positionRef.current = { x, y, z };

    // Render order — larger Z = closer to camera = drawn on top.
    // traverse reaches through the inner anchor group to the actual meshes.
    const order = Math.round(z * 100);
    ref.current.traverse((obj) => { obj.renderOrder = order; });
  });

  function attemptStep(direction: Direction, chained: boolean) {
    if (!canMove(gridColRef.current, gridRowRef.current, direction)) return;

    const dc = direction === 'right' ? 1 : direction === 'left' ? -1 : 0;
    const dr = direction === 'down'  ? 1 : direction === 'up'   ? -1 : 0;
    const toCol = gridColRef.current + dc;
    const toRow = gridRowRef.current + dr;

    const to = tileToWorld(toCol, toRow);

    tweenFromXRef.current = ref.current!.position.x;
    tweenFromZRef.current = ref.current!.position.z;
    tweenToXRef.current   = to.x;
    tweenToZRef.current   = to.z;
    tweenToColRef.current = toCol;
    tweenToRowRef.current = toRow;
    tweenProgressRef.current = 0;
    tweenLinearRef.current = chained;
    isTweeningRef.current = true;
    isMovingRef.current = true;
    directionRef.current = direction;

    // Emit immediately on step commit — no timer throttle needed.
    onMove({ col: toCol, row: toRow, direction, moving: true, zoneKey: activeZoneKeyRef.current });
  }

  return (
    <group ref={ref}>
      {/* Shift all visual children to the character's body anchor so that the
          ring, label, and sprite are all positioned relative to the character
          rather than the raw tile-centre origin. */}
      <group position={[0, 0, SPRITE_ANCHOR_Z]}>
        <AvatarMesh avatar={player.avatar} directionRef={directionRef} isMovingRef={isMovingRef} />
        <PlayerLabel name={player.name} />
        <StatusRing speaking={isSpeaking} />
      </group>
    </group>
  );
}
