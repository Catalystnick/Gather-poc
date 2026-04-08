import { useEffect, useState } from "react";
import { Leva } from "leva";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
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
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const { worldKey } = useParams<{ worldKey?: string }>();
  const [player, setPlayer] = useState<Player | null>(null);
  const [activeWorldKey, setActiveWorldKey] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);

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

  async function handleSignOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await signOut();
      navigate("/login", { replace: true });
    } finally {
      setIsSigningOut(false);
    }
  }

  if (!player) {
    return <AvatarSelect initial={loadSaved()} onJoin={handleJoin} />;
  }

  return (
    <>
      <Leva hidden={import.meta.env.PROD} />
      <button
        type="button"
        onClick={handleSignOut}
        disabled={isSigningOut}
        style={logoutButtonStyle}
      >
        {isSigningOut ? "Signing out..." : "Log out"}
      </button>
      <World
        player={player}
        initialWorldKey={worldKey?.trim() || null}
        onWorldKeyChange={setActiveWorldKey}
      />
    </>
  );
}

const logoutButtonStyle: React.CSSProperties = {
  position: "fixed",
  top: 16,
  right: 16,
  zIndex: 1000,
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #5d6775",
  background: "#1d2430",
  color: "#ffffff",
  fontSize: 14,
  cursor: "pointer",
};
