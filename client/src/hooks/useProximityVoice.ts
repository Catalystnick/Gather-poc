// Phase 2 — WebRTC P2P proximity voice
// Manages peer connections based on distance to remote players.
// Signaling is relayed through the Socket.IO server.

import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { RemotePlayer } from "../types";

const VOICE_RANGE = 8;
const SPEAKING_THRESHOLD = 20;
const MAX_PLAYBACK_VOLUME = 0.7; // Cap volume to reduce feedback
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false, // AGC can amplify feedback and cause screeching
    // Chrome: cuts low-freq rumble that feeds back (ignored by other browsers)
    googHighpassFilter: true,
  } as MediaTrackConstraints,
  video: false,
};

interface PeerEntry {
  connection: RTCPeerConnection;
  audio: HTMLAudioElement; // handles playback — reliable on mobile
  analyser: AnalyserNode; // Web Audio API used only for speaking detection
  pendingCandidates: RTCIceCandidateInit[];
}

interface PendingOffer {
  from: string;
  offer: RTCSessionDescriptionInit;
}

export function useProximityVoice(
  socket: Socket | null,
  localPositionRef: React.MutableRefObject<{ x: number; y: number; z: number }>,
  remotePlayers: Map<string, RemotePlayer>,
) {
  const [muted, setMuted] = useState(false);
  const [isLocalSpeaking, setIsLocalSpeaking] = useState(false);
  const [speakingPeers, setSpeakingPeers] = useState<Set<string>>(new Set());
  const [connectedPeers, setConnectedPeers] = useState<Set<string>>(new Set());

  const localStream = useRef<MediaStream | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const localAnalyser = useRef<AnalyserNode | null>(null);
  const peers = useRef<Map<string, PeerEntry>>(new Map());
  const [isMicReady, setIsMicReady] = useState(false);
  const pendingOffers = useRef<PendingOffer[]>([]);

  const remotePlayersRef = useRef(remotePlayers);
  remotePlayersRef.current = remotePlayers;

  const wasLocalSpeaking = useRef(false);
  const wasSpeakingPeers = useRef(new Set<string>());

  // Acquire mic and set up local speaking analyser
  useEffect(() => {
    const ctx = new AudioContext();
    audioCtx.current = ctx;

    if (navigator.mediaDevices) {
      navigator.mediaDevices
        .getUserMedia(AUDIO_CONSTRAINTS)
        .then((stream) => {
          localStream.current = stream;
          setIsMicReady(true);
          ctx.resume();

          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          ctx.createMediaStreamSource(stream).connect(analyser);
          localAnalyser.current = analyser;

          // Attach the mic to peers that were created while permission was pending.
          peers.current.forEach(({ connection }) => {
            attachLocalTracks(connection, stream);
          });

          const queuedOffers = [...pendingOffers.current];
          pendingOffers.current = [];
          queuedOffers.forEach(({ from, offer }) => {
            void handleOffer(from, offer, stream);
          });
        })
        .catch((err) => console.warn("[voice] mic denied:", err));
    } else {
      console.warn(
        "[voice] mediaDevices unavailable — voice requires HTTPS or localhost",
      );
    }

    const resume = () => {
      ctx.resume();
    };
    window.addEventListener("pointerdown", resume, { once: true });

    return () => {
      window.removeEventListener("pointerdown", resume);
      peers.current.forEach(({ connection, audio }) => {
        connection.close();
        audio.pause();
        audio.srcObject = null;
      });
      peers.current.clear();
      localStream.current?.getTracks().forEach((t) => t.stop());
      ctx.close();
    };
  }, []);

  // Handle incoming signaling events
  useEffect(() => {
    if (!socket) return;

    socket.on(
      "rtc:offer",
      async ({
        from,
        offer,
      }: {
        from: string;
        offer: RTCSessionDescriptionInit;
      }) => {
        if (!localStream.current) {
          console.log(`[voice] queueing offer from ${from} until mic is ready`);
          pendingOffers.current = [
            ...pendingOffers.current.filter((entry) => entry.from !== from),
            { from, offer },
          ];
          return;
        }

        await handleOffer(from, offer, localStream.current);
      },
    );

    socket.on(
      "rtc:answer",
      async ({
        from,
        answer,
      }: {
        from: string;
        answer: RTCSessionDescriptionInit;
      }) => {
        const entry = peers.current.get(from);
        if (!entry) return;
        await entry.connection.setRemoteDescription(answer);
        await flushPendingCandidates(from);
      },
    );

    socket.on(
      "rtc:ice-candidate",
      async ({
        from,
        candidate,
      }: {
        from: string;
        candidate: RTCIceCandidateInit;
      }) => {
        const entry = peers.current.get(from);
        if (!entry) return;

        if (!entry.connection.remoteDescription) {
          entry.pendingCandidates.push(candidate);
          return;
        }

        await entry.connection.addIceCandidate(candidate);
      },
    );

    socket.on("rtc:hangup", ({ from }: { from: string }) => closePeer(from));

    return () => {
      socket.off("rtc:offer");
      socket.off("rtc:answer");
      socket.off("rtc:ice-candidate");
      socket.off("rtc:hangup");
    };
  }, [socket]);

  // Proximity + speaking detection
  useEffect(() => {
    if (!socket || !isMicReady) return;

    const dataArray = new Uint8Array(128);

    const interval = setInterval(() => {
      const local = localPositionRef.current;
      const remote = remotePlayersRef.current;
      const nextSpeaking = new Set<string>();

      // Local speaking detection
      if (localAnalyser.current) {
        localAnalyser.current.getByteFrequencyData(dataArray);
        const speaking = rmsOf(dataArray) > SPEAKING_THRESHOLD;
        if (speaking !== wasLocalSpeaking.current) {
          console.log(
            `[voice] you ${speaking ? "started" : "stopped"} speaking`,
          );
          wasLocalSpeaking.current = speaking;
        }
        setIsLocalSpeaking(speaking);
      }

      // Proximity + remote speaking detection
      remote.forEach((player, id) => {
        const dist = distance(local, player.position);
        const connected = peers.current.has(id);

        if (dist < VOICE_RANGE && !connected) {
          // Only the side with the lower socket ID initiates to prevent glare
          if ((socket.id ?? "") < id) {
            console.log(`[rtc] initiating connection to ${id}`);
            initiatePeer(id, socket);
          }
        } else if (dist >= VOICE_RANGE && connected) {
          closePeer(id);
          socket.emit("rtc:hangup", { to: id });
        } else if (connected) {
          const entry = peers.current.get(id)!;

          // Volume via audio element — cap to reduce feedback/screeching
          entry.audio.volume = Math.min(
            MAX_PLAYBACK_VOLUME,
            Math.max(0, 1 - dist / VOICE_RANGE)
          );

          // Speaking detection via analyser
          entry.analyser.getByteFrequencyData(dataArray);
          const remoteSpeaking = rmsOf(dataArray) > SPEAKING_THRESHOLD;
          if (remoteSpeaking) nextSpeaking.add(id);

          const name = remote.get(id)?.name ?? id;
          const wasSpeaking = wasSpeakingPeers.current.has(id);
          if (remoteSpeaking && !wasSpeaking)
            console.log(`[voice] ${name} started speaking`);
          if (!remoteSpeaking && wasSpeaking)
            console.log(`[voice] ${name} stopped speaking`);
        }
      });

      wasSpeakingPeers.current = nextSpeaking;
      setSpeakingPeers(nextSpeaking);
      setConnectedPeers(new Set(peers.current.keys()));
    }, 100);

    return () => clearInterval(interval);
  }, [socket, isMicReady]);

  function getOrCreatePeer(
    peerId: string,
    socket: Socket,
    initiator: boolean,
  ): RTCPeerConnection {
    if (peers.current.has(peerId)) return peers.current.get(peerId)!.connection;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const ctx = audioCtx.current!;

    // <audio> element handles playback — more reliable on mobile than Web Audio API
    const audio = new Audio();
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");
    audio.volume = 0.5; // Lower default to reduce feedback

    // Analyser for speaking detection only — NOT connected to audio destination
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;

    if (localStream.current) {
      attachLocalTracks(pc, localStream.current);
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate)
        socket.emit("rtc:ice-candidate", { to: peerId, candidate });
    };

    pc.onconnectionstatechange = () => {
      console.log(`[rtc] connection to ${peerId}: ${pc.connectionState}`);
    };

    pc.ontrack = ({ streams }) => {
      console.log(`[rtc] received audio track from ${peerId}`);

      // Wire stream to <audio> element for playback
      audio.srcObject = streams[0];
      audio.play().catch((e) => console.warn("[voice] audio play failed:", e));

      // Wire stream to analyser for speaking detection
      ctx.createMediaStreamSource(streams[0]).connect(analyser);
    };

    peers.current.set(peerId, {
      connection: pc,
      audio,
      analyser,
      pendingCandidates: [],
    });

    if (initiator) {
      pc.createOffer().then((offer) => {
        pc.setLocalDescription(offer);
        socket.emit("rtc:offer", { to: peerId, offer });
      });
    }

    return pc;
  }

  function initiatePeer(peerId: string, socket: Socket) {
    getOrCreatePeer(peerId, socket, true);
  }

  function closePeer(peerId: string) {
    const entry = peers.current.get(peerId);
    if (entry) {
      entry.connection.close();
      entry.audio.pause();
      entry.audio.srcObject = null;
      peers.current.delete(peerId);
    }
  }

  async function flushPendingCandidates(peerId: string) {
    const entry = peers.current.get(peerId);
    if (!entry || !entry.connection.remoteDescription) return;

    while (entry.pendingCandidates.length > 0) {
      const candidate = entry.pendingCandidates.shift();
      if (candidate) await entry.connection.addIceCandidate(candidate);
    }
  }

  async function handleOffer(
    from: string,
    offer: RTCSessionDescriptionInit,
    stream: MediaStream,
  ) {
    if (!socket) return;

    const pc = getOrCreatePeer(from, socket, false);
    attachLocalTracks(pc, stream);
    await pc.setRemoteDescription(offer);
    await flushPendingCandidates(from);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("rtc:answer", { to: from, answer });
  }

  function toggleMute() {
    setMuted((m) => {
      const next = !m;
      localStream.current?.getAudioTracks().forEach((t) => {
        t.enabled = !next; // enabled=true sends audio, enabled=false mutes
      });
      return next;
    });
  }

  return { muted, toggleMute, isLocalSpeaking, speakingPeers, connectedPeers };
}

function rmsOf(data: Uint8Array): number {
  return Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length);
}

function distance(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function attachLocalTracks(connection: RTCPeerConnection, stream: MediaStream) {
  const existingTrackIds = new Set(
    connection
      .getSenders()
      .map((sender) => sender.track?.id)
      .filter((id): id is string => Boolean(id)),
  );

  stream.getTracks().forEach((track) => {
    if (!existingTrackIds.has(track.id)) {
      connection.addTrack(track, stream);
    }
  });
}
