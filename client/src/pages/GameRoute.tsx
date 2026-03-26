import { useState } from "react";
import { Leva } from "leva";
import { useAuth } from "../contexts/AuthContext";
import AvatarSelect from "../components/ui/AvatarSelect";
import World from "../components/scene/World";
import type { Player } from "../types";

const STORAGE_KEY = "gather_poc_avatar";

//this information should be moved to backend
function loadSaved(): Player | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { name?: string; avatar?: { shirt?: string } };
    if (typeof p?.name !== "string" || typeof p?.avatar?.shirt !== "string") return null;
    return { name: p.name, avatar: { shirt: p.avatar.shirt } };
  } catch {
    return null;
  }
}

export default function GameRoute() {
  const { session } = useAuth();
  const [player, setPlayer] = useState<Player | null>(null);

  console.log("[GameRoute] authenticated | user:", session?.user?.email, "| token length:", session?.access_token?.length);

  function handleJoin(p: Player) {
    console.log("[GameRoute] player joined avatar select → name:", p.name, "| shirt:", p.avatar.shirt);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    setPlayer(p);
  }

  if (!player) {
    console.log("[GameRoute] showing AvatarSelect (no player yet)");
    return <AvatarSelect initial={loadSaved()} onJoin={handleJoin} />;
  }

  console.log("[GameRoute] mounting World with player:", player.name);
  return (
    <>
      <Leva hidden={import.meta.env.PROD} />
      <World player={player} />
    </>
  );
}
