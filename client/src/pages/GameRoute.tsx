import { useEffect, useState } from "react";
import { Leva } from "leva";
import { useNavigate, useParams } from "react-router-dom";
import AvatarSelect from "../components/ui/AvatarSelect";
import World from "../components/scene/World";
import {
  ensureNotificationPermissionOnUserGesture,
  maybeRequestNotificationPermission,
} from "../chat/notificationService";
import type { Player } from "../types";

const STORAGE_KEY = "gather_poc_avatar";

// this information should be moved to backend
/** Load locally persisted avatar selection for quick re-entry. */
function loadSaved(): Player | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsedPlayer = JSON.parse(raw) as { name?: string; avatar?: { shirt?: string } };
    if (typeof parsedPlayer?.name !== "string" || typeof parsedPlayer?.avatar?.shirt !== "string") return null;
    return { name: parsedPlayer.name, avatar: { shirt: parsedPlayer.avatar.shirt } };
  } catch {
    return null;
  }
}

/** Gate into avatar selection until a local player profile is chosen. */
export default function GameRoute() {
  const navigate = useNavigate();
  const { worldKey } = useParams<{ worldKey?: string }>();
  const [player, setPlayer] = useState<Player | null>(null);
  const [activeWorldKey, setActiveWorldKey] = useState<string | null>(null);

  // Install permission/audio priming hooks as soon as the game route loads so
  // the very first user gesture can unlock audio and trigger notification prompt.
  useEffect(() => {
    ensureNotificationPermissionOnUserGesture();
  }, []);

  useEffect(() => {
    const normalizedCurrent = typeof worldKey === "string" ? worldKey.trim() : "";
    const normalizedActive = typeof activeWorldKey === "string" ? activeWorldKey.trim() : "";
    if (!normalizedActive || normalizedActive === normalizedCurrent) return;
    navigate(`/game/${normalizedActive}`, { replace: true });
  }, [activeWorldKey, navigate, worldKey]);

  /** Persist selected player profile and enter the world scene. */
  function handleJoin(nextPlayer: Player) {
    // Join click/submit is a user gesture, so this is the best point to ask.
    maybeRequestNotificationPermission();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextPlayer));
    setPlayer(nextPlayer);
  }

  if (!player) {
    return <AvatarSelect initial={loadSaved()} onJoin={handleJoin} />;
  }

  return (
    <>
      <Leva hidden={import.meta.env.PROD} />
      <World
        player={player}
        initialWorldKey={worldKey?.trim() || null}
        onWorldKeyChange={setActiveWorldKey}
      />
    </>
  );
}
