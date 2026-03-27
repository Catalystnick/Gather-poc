import { memo, useLayoutEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";
import AvatarMesh, { SPRITE_ANCHOR_Z } from "./AvatarMesh";
import ChatBubble from "./ChatBubble";
import PlayerLabel from "./PlayerLabel";
import StatusRing from "./StatusRing";
import type { Avatar, Direction } from "../../types";
import { tileToWorld } from "../../utils/gridHelpers";

// Must match LocalPlayer's TWEEN_DURATION so remote tweens finish before the
// next move event arrives under normal network conditions.
const TWEEN_DURATION = 0.15

interface Props {
  id: string;
  name: string;
  avatar: Avatar;
  col: number;
  row: number;
  direction: Direction;
  moving: boolean;
  bubble?: string;
  inRange?: boolean;
  isSpeaking?: boolean;
}

function RemotePlayer({ name, avatar, col, row, direction, moving, bubble, inRange, isSpeaking }: Props) {
  const ref = useRef<Group>(null);

  // Animation state driven directly by the sender — no delta inference.
  const directionRef = useRef<Direction>(direction);
  const isMovingRef  = useRef(moving);
  directionRef.current = direction;
  isMovingRef.current  = moving;

  // Tween state — start from current visual position to avoid snapping on
  // in-flight tween interruption (network jitter, late packets, etc.).
  const isTweeningRef    = useRef(false);
  const tweenProgressRef = useRef(0);
  const tweenFromXRef    = useRef(0);
  const tweenFromZRef    = useRef(0);
  const tweenToXRef      = useRef(0);
  const tweenToZRef      = useRef(0);

  // Track the last tile we received so we only start a new tween when the
  // server reports an actual position change.
  const lastColRef = useRef(col);
  const lastRowRef = useRef(row);

  // Initialise mesh at spawn tile before the first frame.
  useLayoutEffect(() => {
    const { x, z } = tileToWorld(col, row);
    ref.current?.position.set(x, 0.5, z);
    tweenFromXRef.current = x;
    tweenFromZRef.current = z;
    tweenToXRef.current   = x;
    tweenToZRef.current   = z;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // React to incoming tile updates from the server.
  // Runs on every render caused by a socket update — starts a tween from the
  // current visual position so partial tweens never cause backward snapping.
  if (col !== lastColRef.current || row !== lastRowRef.current) {
    lastColRef.current = col;
    lastRowRef.current = row;
    const to = tileToWorld(col, row);
    // Start from wherever the sprite currently is (may be mid-tween).
    tweenFromXRef.current  = ref.current ? ref.current.position.x : tweenToXRef.current;
    tweenFromZRef.current  = ref.current ? ref.current.position.z : tweenToZRef.current;
    tweenToXRef.current    = to.x;
    tweenToZRef.current    = to.z;
    tweenProgressRef.current = 0;
    isTweeningRef.current  = true;
  }

  useFrame((_, delta) => {
    if (!ref.current) return;

    if (isTweeningRef.current) {
      tweenProgressRef.current += delta / TWEEN_DURATION;

      if (tweenProgressRef.current >= 1) {
        isTweeningRef.current = false;
        tweenProgressRef.current = 1;
        ref.current.position.x = tweenToXRef.current;
        ref.current.position.z = tweenToZRef.current;
      } else {
        // Linear — remote tweens chain continuously as move events arrive,
        // so constant speed is correct here (same reasoning as LocalPlayer).
        const t = tweenProgressRef.current;
        ref.current.position.x = tweenFromXRef.current + (tweenToXRef.current - tweenFromXRef.current) * t;
        ref.current.position.z = tweenFromZRef.current + (tweenToZRef.current - tweenFromZRef.current) * t;
      }
    }

    const order = Math.round(ref.current.position.z * 100);
    ref.current.traverse((obj) => { obj.renderOrder = order; });
  });

  return (
    <group ref={ref}>
      <group position={[0, 0, SPRITE_ANCHOR_Z]}>
        <AvatarMesh avatar={avatar} directionRef={directionRef} isMovingRef={isMovingRef} />
        <StatusRing speaking={isSpeaking} inRange={inRange} />
        <PlayerLabel name={name} />
        {bubble && <ChatBubble text={bubble} />}
      </group>
    </group>
  );
}

export default memo(RemotePlayer)
