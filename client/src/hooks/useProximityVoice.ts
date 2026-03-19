// Phase 2 — WebRTC P2P proximity voice
// Manages peer connections based on distance to remote players.
// Signaling is relayed through the Socket.IO server.

import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { RemotePlayer } from "../types";

const CONNECT_RANGE = 7;
const DISCONNECT_RANGE = 9;
const SPEAKING_THRESHOLD = 20;
// GainNode.gain is not capped at 1.0 — the slider's full 0.5–5× range works.
const MIN_GAIN_FLOOR = 0.05; // never fully silent even at the edge of range
const MAX_ACTIVE_PEERS = 8; // admission control for dense crowds
const TELEMETRY_EVERY_MS = 15000;
const GAIN_STORAGE_KEY = "gather_poc_remote_gain";
const DISCONNECTED_GRACE_MS = 5000;
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];
const ICE_SERVERS = resolveIceServers();

// iOS Safari requires autoGainControl for audible mic levels;
// on desktop, AGC can amplify feedback so we leave it off.
const IS_MOBILE = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
  typeof navigator !== "undefined" ? navigator.userAgent : "",
);
const AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: IS_MOBILE,
    // Chrome-only: cuts low-freq rumble that feeds back.
    ...(IS_MOBILE ? {} : { googHighpassFilter: true }),
  } as MediaTrackConstraints,
  video: false,
};

interface PeerEntry {
  connection: RTCPeerConnection;
  // Remote audio is routed entirely through Web Audio:
  //   MediaStreamAudioSourceNode → gainNode → ctx.destination   (playback)
  //   MediaStreamAudioSourceNode → analyser                     (speaking detection)
  // Using GainNode instead of HTMLAudioElement.volume allows gain values > 1.0,
  // which is required for the 0.5–5× slider to have any effect.
  gainNode: GainNode;
  analyser: AnalyserNode;
  analyserSource: MediaStreamAudioSourceNode | null;
  pendingCandidates: RTCIceCandidateInit[];
}

interface Telemetry {
  negotiationAttempts: number;
  negotiationFailures: number;
  cleanupCount: number;
  activePeerPeak: number;
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
  const [peerConnectionStates, setPeerConnectionStates] = useState<
    Record<string, string>
  >({});
  const [remoteGain, setRemoteGain] = useState(loadRemoteGain());
  // True when AudioContext is suspended (iOS autoplay policy) AND peers are connected.
  // Clears automatically once the user taps (which resumes the context).
  const [audioBlocked, setAudioBlocked] = useState(false);

  const localStream = useRef<MediaStream | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const localAnalyser = useRef<AnalyserNode | null>(null);
  const peers = useRef<Map<string, PeerEntry>>(new Map());
  const [isMicReady, setIsMicReady] = useState(false);
  const connectingPeers = useRef<Set<string>>(new Set());
  const hangupSent = useRef<Set<string>>(new Set());
  const disconnectTimers = useRef<Map<string, number>>(new Map());
  const telemetry = useRef<Telemetry>({
    negotiationAttempts: 0,
    negotiationFailures: 0,
    cleanupCount: 0,
    activePeerPeak: 0,
  });

  const remotePlayersRef = useRef(remotePlayers);
  remotePlayersRef.current = remotePlayers;
  const remoteGainRef = useRef(remoteGain);
  remoteGainRef.current = remoteGain;

  const wasLocalSpeaking = useRef(false);
  const wasSpeakingPeers = useRef(new Set<string>());

  // Acquire mic and set up local speaking analyser.
  useEffect(() => {
    // AudioContext must be created eagerly so ICE/peer setup can reference it,
    // but iOS Safari keeps it suspended until a user-gesture resume() call.
    // We try an immediate resume (works on desktop) and rely on the gesture
    // handlers below for iOS.
    const ctx = new AudioContext();
    audioCtx.current = ctx;
    void ctx.resume().catch(() => {/* ignored — will retry on gesture */});

    ctx.onstatechange = () => {
      // Clear the banner as soon as the context resumes; show it if it
      // suspends again while peers are connected.
      setAudioBlocked(ctx.state === "suspended" && peers.current.size > 0);
    };

    const resumeOnGesture = () => {
      void ctx.resume();
    };

    if (navigator.mediaDevices) {
      navigator.mediaDevices
        .getUserMedia(AUDIO_CONSTRAINTS)
        .then((stream) => {
          localStream.current = stream;
          setIsMicReady(true);
          // ctx.resume() here is outside a user-gesture on iOS and is silently
          // ignored; the gesture handlers above are the reliable path.
          void ctx.resume().catch(() => {/* will resume on next gesture */});

          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          ctx.createMediaStreamSource(stream).connect(analyser);
          localAnalyser.current = analyser;

          // Attach mic tracks to peers that were created while permission was pending.
          peers.current.forEach(({ connection }, peerId) => {
            attachLocalTracks(connection, stream);
            if (socket) {
              void renegotiatePeer(peerId, socket);
            }
          });

        })
        .catch((err) => console.warn("[voice] mic denied:", err));
    } else {
      console.warn(
        "[voice] mediaDevices unavailable — voice requires HTTPS or localhost",
      );
    }

    window.addEventListener("pointerdown", resumeOnGesture);
    window.addEventListener("keydown", resumeOnGesture);
    window.addEventListener("touchstart", resumeOnGesture, { passive: true });

    return () => {
      window.removeEventListener("pointerdown", resumeOnGesture);
      window.removeEventListener("keydown", resumeOnGesture);
      window.removeEventListener("touchstart", resumeOnGesture);
      [...peers.current.keys()].forEach((peerId) => {
        closePeer(peerId, { emitHangup: false, reason: "hook cleanup" });
      });
      peers.current.clear();
      connectingPeers.current.clear();
      disconnectTimers.current.forEach((timerId) => window.clearTimeout(timerId));
      disconnectTimers.current.clear();
      localStream.current?.getTracks().forEach((track) => track.stop());
      void ctx.close();
    };
  }, []);

  // Lightweight periodic telemetry to help diagnose crowd behavior.
  useEffect(() => {
    const interval = setInterval(() => {
      console.debug("[voice] telemetry", {
        ...telemetry.current,
        connected: peers.current.size,
        connecting: connectingPeers.current.size,
        audioCtxState: audioCtx.current?.state,
      });
    }, TELEMETRY_EVERY_MS);
    return () => clearInterval(interval);
  }, []);

  // Handle incoming signaling events.
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
        await handleOffer(from, offer, localStream.current ?? undefined);
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
        try {
          await entry.connection.setRemoteDescription(answer);
          await flushPendingCandidates(from);
          connectingPeers.current.delete(from);
        } catch (err) {
          telemetry.current.negotiationFailures += 1;
          console.warn(`[rtc] failed to apply answer from ${from}`, err);
          closePeer(from, {
            emitHangup: true,
            socket,
            reason: "answer application failed",
          });
        }
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

        try {
          await entry.connection.addIceCandidate(candidate);
        } catch (err) {
          console.warn(`[rtc] failed to add ice candidate from ${from}`, err);
        }
      },
    );

    socket.on("rtc:hangup", ({ from }: { from: string }) => {
      closePeer(from, { emitHangup: false, reason: "remote hangup" });
    });

    return () => {
      socket.off("rtc:offer");
      socket.off("rtc:answer");
      socket.off("rtc:ice-candidate");
      socket.off("rtc:hangup");
    };
  }, [socket]);

  // Proximity + speaking detection + admission control.
  useEffect(() => {
    if (!socket) return;

    const dataArray = new Uint8Array(128);

    const interval = setInterval(() => {
      const local = localPositionRef.current;
      const remote = remotePlayersRef.current;
      const ctx = audioCtx.current;
      const nextSpeaking = new Set<string>();

      // Local speaking detection
      if (localAnalyser.current) {
        localAnalyser.current.getByteFrequencyData(dataArray);
        const speaking = rmsOf(dataArray) > SPEAKING_THRESHOLD;
        if (speaking !== wasLocalSpeaking.current) {
          console.log(`[voice] you ${speaking ? "started" : "stopped"} speaking`);
          wasLocalSpeaking.current = speaking;
        }
        setIsLocalSpeaking(speaking);
      }

      const candidates = [...remote.entries()]
        .map(([id, player]) => ({
          id,
          player,
          distance: distance(local, player.position),
        }))
        .filter((entry) => entry.distance < DISCONNECT_RANGE)
        .sort((a, b) => a.distance - b.distance);
      const preferredPeerIds = new Set(
        candidates.slice(0, MAX_ACTIVE_PEERS).map((entry) => entry.id),
      );

      // Disconnect stale peers no longer visible in room state.
      for (const peerId of peers.current.keys()) {
        if (!remote.has(peerId)) {
          setPeerConnectionState(peerId, null);
          closePeer(peerId, { emitHangup: false, reason: "peer left room" });
        }
      }

      // Proximity + remote gain + speaking detection.
      remote.forEach((player, id) => {
        const dist = distance(local, player.position);
        const connected = peers.current.has(id);
        const preferred = preferredPeerIds.has(id);

        if (
          socket.id &&
          dist < CONNECT_RANGE &&
          preferred &&
          !connected &&
          !connectingPeers.current.has(id)
        ) {
          // Only the side with the lower socket ID initiates to prevent glare.
          if ((socket.id ?? "") < id) {
            console.log(`[rtc] initiating connection to ${id}`);
            initiatePeer(id, socket);
          }
        } else if (
          connected &&
          dist > DISCONNECT_RANGE
        ) {
          closePeer(id, {
            emitHangup: true,
            socket,
            reason: "out of range",
          });
        } else if (connected) {
          const entry = peers.current.get(id);
          if (!entry || !ctx) return;

          // GainNode.gain has no 1.0 ceiling — the full 0.5–5× slider range works.
          const userGain = remoteGainRef.current;
          const normalized = Math.min(1, Math.max(0, dist / DISCONNECT_RANGE));
          const distanceFactor = 1 - normalized ** 1.4;
          const targetGain = Math.max(MIN_GAIN_FLOOR, distanceFactor * userGain);
          // setTargetAtTime with a short time constant smooths gain changes to
          // avoid audible clicks when distance or slider value changes.
          entry.gainNode.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.05);

          // Speaking detection via analyser.
          entry.analyser.getByteFrequencyData(dataArray);
          const remoteSpeaking = rmsOf(dataArray) > SPEAKING_THRESHOLD;
          if (remoteSpeaking) nextSpeaking.add(id);

          const name = player.name ?? id;
          const wasSpeaking = wasSpeakingPeers.current.has(id);
          if (remoteSpeaking && !wasSpeaking) {
            console.log(`[voice] ${name} started speaking`);
          }
          if (!remoteSpeaking && wasSpeaking) {
            console.log(`[voice] ${name} stopped speaking`);
          }
        }
      });

      telemetry.current.activePeerPeak = Math.max(
        telemetry.current.activePeerPeak,
        peers.current.size,
      );
      wasSpeakingPeers.current = nextSpeaking;
      setSpeakingPeers(nextSpeaking);
      setConnectedPeers(new Set(peers.current.keys()));
      // Keep audioBlocked in sync with context state (onstatechange handles it too,
      // but this catches cases where the context suspends between state events).
      setAudioBlocked(
        (audioCtx.current?.state === "suspended") && peers.current.size > 0,
      );
    }, 100);

    return () => clearInterval(interval);
  }, [socket, isMicReady]);

  function getOrCreatePeer(
    peerId: string,
    signalSocket: Socket,
    initiator: boolean,
  ): RTCPeerConnection {
    const existing = peers.current.get(peerId);
    if (existing) return existing.connection;

    connectingPeers.current.add(peerId);
    setPeerConnectionState(peerId, "connecting");
    telemetry.current.negotiationAttempts += 1;
    hangupSent.current.delete(peerId);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const ctx = audioCtx.current;
    if (!ctx) {
      throw new Error("Audio context is not ready");
    }

    // GainNode controls both distance-based attenuation and the user's slider.
    // Unlike HTMLAudioElement.volume, GainNode.gain can exceed 1.0 for true amplification.
    const gainNode = ctx.createGain();
    gainNode.gain.value = MIN_GAIN_FLOOR;
    gainNode.connect(ctx.destination);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;

    if (localStream.current) {
      attachLocalTracks(pc, localStream.current);
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        signalSocket.emit("rtc:ice-candidate", { to: peerId, candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log(`[rtc] connection to ${peerId}: ${state}`);

      if (state === "connected") {
        connectingPeers.current.delete(peerId);
        setPeerConnectionState(peerId, "connected");
        const timer = disconnectTimers.current.get(peerId);
        if (timer) {
          window.clearTimeout(timer);
          disconnectTimers.current.delete(peerId);
        }
      }

      if (state === "disconnected") {
        setPeerConnectionState(peerId, "disconnected");
        if (!disconnectTimers.current.has(peerId)) {
          const timer = window.setTimeout(() => {
            disconnectTimers.current.delete(peerId);
            const currentState = peers.current.get(peerId)?.connection.connectionState;
            if (currentState === "disconnected") {
              closePeer(peerId, {
                emitHangup: true,
                socket: signalSocket,
                reason: "disconnected timeout",
              });
            }
          }, DISCONNECTED_GRACE_MS);
          disconnectTimers.current.set(peerId, timer);
        }
      }

      if (state === "failed" || state === "closed") {
        setPeerConnectionState(peerId, state);
        closePeer(peerId, {
          emitHangup: state !== "closed",
          socket: signalSocket,
          reason: `connection state ${state}`,
        });
      }
    };

    pc.ontrack = (event) => {
      // MDN: event.streams can be empty (streamless track); create MediaStream from track.
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      if (!stream.getAudioTracks().length) return;

      console.log(`[rtc] received audio track from ${peerId}`);

      const entry = peers.current.get(peerId);
      if (!entry) return;

      if (!entry.analyserSource) {
        // Route the stream through the Web Audio graph:
        //   source → gainNode → ctx.destination  (audible output)
        //   source → analyser                    (speaking detection, no output)
        // Both uses share the same source node so the stream is only "consumed" once,
        // which avoids the iOS Safari bug where multiple consumers silence each other.
        const source = ctx.createMediaStreamSource(stream);
        source.connect(entry.gainNode);
        source.connect(entry.analyser);
        entry.analyserSource = source;
      }
    };

    peers.current.set(peerId, {
      connection: pc,
      gainNode,
      analyser,
      analyserSource: null,
      pendingCandidates: [],
    });

    if (initiator) {
      void (async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          signalSocket.emit("rtc:offer", { to: peerId, offer });
        } catch (err) {
          telemetry.current.negotiationFailures += 1;
          console.warn(`[rtc] failed to create offer for ${peerId}`, err);
          closePeer(peerId, {
            emitHangup: true,
            socket: signalSocket,
            reason: "offer creation failed",
          });
        }
      })();
    }

    return pc;
  }

  function initiatePeer(peerId: string, signalSocket: Socket) {
    if (connectingPeers.current.has(peerId) || peers.current.has(peerId)) return;
    getOrCreatePeer(peerId, signalSocket, true);
  }

  function closePeer(
    peerId: string,
    opts?: { emitHangup?: boolean; socket?: Socket; reason?: string },
  ) {
    const entry = peers.current.get(peerId);
    if (!entry) return;

    peers.current.delete(peerId);
    connectingPeers.current.delete(peerId);
    const timer = disconnectTimers.current.get(peerId);
    if (timer) {
      window.clearTimeout(timer);
      disconnectTimers.current.delete(peerId);
    }

    if (entry.analyserSource) {
      entry.analyserSource.disconnect();
      entry.analyserSource = null;
    }
    entry.gainNode.disconnect();
    entry.analyser.disconnect();

    entry.connection.onconnectionstatechange = null;
    entry.connection.onicecandidate = null;
    entry.connection.ontrack = null;
    if (entry.connection.signalingState !== "closed") {
      entry.connection.close();
    }
    setPeerConnectionState(peerId, "closed");
    telemetry.current.cleanupCount += 1;

    if (
      opts?.emitHangup &&
      opts.socket &&
      !hangupSent.current.has(peerId)
    ) {
      hangupSent.current.add(peerId);
      opts.socket.emit("rtc:hangup", { to: peerId });
    }
    if (opts?.reason) {
      console.log(`[rtc] closed peer ${peerId}: ${opts.reason}`);
    }
  }

  async function flushPendingCandidates(peerId: string) {
    const entry = peers.current.get(peerId);
    if (!entry || !entry.connection.remoteDescription) return;

    while (entry.pendingCandidates.length > 0) {
      const candidate = entry.pendingCandidates.shift();
      if (!candidate) continue;
      try {
        await entry.connection.addIceCandidate(candidate);
      } catch (err) {
        console.warn(`[rtc] failed to flush pending candidate for ${peerId}`, err);
      }
    }
  }

  async function handleOffer(
    from: string,
    offer: RTCSessionDescriptionInit,
    stream?: MediaStream,
  ) {
    if (!socket) return;

    try {
      connectingPeers.current.add(from);
      const pc = getOrCreatePeer(from, socket, false);
      if (stream) {
        attachLocalTracks(pc, stream);
      }
      await pc.setRemoteDescription(offer);
      await flushPendingCandidates(from);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("rtc:answer", { to: from, answer });
      connectingPeers.current.delete(from);
    } catch (err) {
      telemetry.current.negotiationFailures += 1;
      console.warn(`[rtc] failed to handle offer from ${from}`, err);
      closePeer(from, { emitHangup: true, socket, reason: "offer handling failed" });
    }
  }

  async function renegotiatePeer(peerId: string, signalSocket: Socket) {
    const entry = peers.current.get(peerId);
    if (!entry) return;
    if (entry.connection.signalingState !== "stable") return;

    try {
      const offer = await entry.connection.createOffer();
      await entry.connection.setLocalDescription(offer);
      signalSocket.emit("rtc:offer", { to: peerId, offer });
    } catch (err) {
      telemetry.current.negotiationFailures += 1;
      console.warn(`[rtc] renegotiation failed for ${peerId}`, err);
    }
  }

  function toggleMute() {
    setMuted((prev) => {
      const nextMuted = !prev;
      localStream.current?.getAudioTracks().forEach((track) => {
        track.enabled = !nextMuted; // enabled=true sends audio, enabled=false mutes
      });
      return nextMuted;
    });
  }

  function updateRemoteGain(value: number) {
    const next = Math.min(5, Math.max(0.5, value));
    setRemoteGain(next);
    localStorage.setItem(GAIN_STORAGE_KEY, String(next));
  }

  function setPeerConnectionState(peerId: string, state: string | null) {
    setPeerConnectionStates((prev) => {
      const next = { ...prev };
      if (state === null) {
        delete next[peerId];
      } else {
        next[peerId] = state;
      }
      return next;
    });
  }

  return {
    muted,
    toggleMute,
    isLocalSpeaking,
    speakingPeers,
    connectedPeers,
    peerConnectionStates,
    remoteGain,
    setRemoteGain: updateRemoteGain,
    audioBlocked,
  };
}

function rmsOf(data: Uint8Array): number {
  return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
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

function resolveIceServers(): RTCIceServer[] {
  const env = import.meta.env as Record<string, string | undefined>;
  const json = env.VITE_ICE_SERVERS_JSON;
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as RTCIceServer[];
      }
      console.warn("[voice] VITE_ICE_SERVERS_JSON is set but not a non-empty array");
    } catch (err) {
      console.warn("[voice] failed to parse VITE_ICE_SERVERS_JSON", err);
    }
  }

  const turnUrl = env.VITE_TURN_URL;
  const turnUsername = env.VITE_TURN_USERNAME;
  const turnCredential = env.VITE_TURN_CREDENTIAL;
  if (turnUrl && turnUsername && turnCredential) {
    return [
      ...DEFAULT_ICE_SERVERS,
      {
        urls: turnUrl,
        username: turnUsername,
        credential: turnCredential,
      },
    ];
  }

  return DEFAULT_ICE_SERVERS;
}

function loadRemoteGain(): number {
  try {
    const raw = localStorage.getItem(GAIN_STORAGE_KEY);
    if (!raw) return IS_MOBILE ? 1.5 : 1; // Higher default on mobile
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) return IS_MOBILE ? 1.5 : 1;
    return Math.min(5, Math.max(0.5, parsed));
  } catch {
    return IS_MOBILE ? 1.5 : 1;
  }
}
