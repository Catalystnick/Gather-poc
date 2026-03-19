// Phase 2 — WebRTC P2P proximity voice
// Manages peer connections based on distance to remote players.
// Signaling is relayed through the Socket.IO server.

import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { RemotePlayer } from "../types";
// RNNoise WebAssembly noise suppression — processes the mic stream through a
// deep-learning model before sending over WebRTC. The ?worker&url modifier is
// Vite-specific and creates a bundled AudioWorklet script at build time.
import NoiseSuppressorWorkletUrl from "@timephy/rnnoise-wasm/NoiseSuppressorWorklet?worker&url";
import { NoiseSuppressorWorklet_Name } from "@timephy/rnnoise-wasm";

const CONNECT_RANGE = 7;
const DISCONNECT_RANGE = 9;
const SPEAKING_THRESHOLD = 20;
// GainNode.gain is not capped at 1.0 — the slider's full 0.5–5× range works.
// 0.15 keeps distant peers audible on phone speakers without being intrusive.
const MIN_GAIN_FLOOR = 0.15;
const MAX_ACTIVE_PEERS = 8; // admission control for dense crowds
const TELEMETRY_EVERY_MS = 15000;
const GAIN_STORAGE_KEY = "gather_poc_remote_gain";
const DISCONNECTED_GRACE_MS = 5000;
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];
// Resolved once at module load. Chrome/Safari use STUN (+ optional TURN).
// Firefox always gets TURN if configured — see IS_FIREFOX usage below.
const ICE_SERVERS_DEFAULT = resolveIceServers();
const ICE_SERVERS_FIREFOX = resolveIceServersForFirefox();

const IS_MOBILE = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
  typeof navigator !== "undefined" ? navigator.userAgent : "",
);
// iOS routes getUserMedia audio sessions to the earpiece by default.
// We detect it separately so we can apply the loudspeaker override trick.
const IS_IOS = /iPhone|iPad|iPod/i.test(
  typeof navigator !== "undefined" ? navigator.userAgent : "",
);
// Firefox uses a different ICE candidate strategy than Chromium-based browsers.
// Chrome obfuscates LAN IPs with mDNS `.local` hostnames (privacy feature); Firefox
// can't resolve those, so Chrome↔Firefox connections fail without a TURN relay.
// We detect Firefox here so getOrCreatePeer can use a TURN-inclusive ICE config.
const IS_FIREFOX = /Firefox\//i.test(
  typeof navigator !== "undefined" ? navigator.userAgent : "",
);
const AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    // RNNoise handles noise suppression in the AudioWorklet pipeline below.
    // Leaving the browser's native suppressor on alongside RNNoise causes
    // double-processing artefacts (phase issues, speech colouration).
    noiseSuppression: false,
    // AGC: enabled on mobile so the OS normalises mic input levels — without it,
    // mobile mics send a quiet raw signal and the receiving side hears low volume.
    // Disabled on desktop where headset hardware manages gain staging.
    autoGainControl: IS_MOBILE,
    // Chrome-only: cuts low-freq rumble that feeds back.
    ...(IS_MOBILE ? {} : { googHighpassFilter: true }),
  } as MediaTrackConstraints,
  video: false,
};

// Older iOS/macOS Safari ships the Web Audio API under the webkit prefix.
const AudioContextCtor: typeof AudioContext =
  window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

interface PeerEntry {
  connection: RTCPeerConnection;
  // Chrome bug: WebRTC streams routed *only* through Web Audio are silent.
  // Chrome requires the stream to be attached to a muted HTMLAudioElement to
  // activate its internal audio pipeline before createMediaStreamSource() works.
  // The muted element produces no output — it exists solely as a Chrome workaround.
  // Firefox and Safari don't need this, but it's harmless for them.
  // Ref: https://stackoverflow.com/questions/55703316
  audio: HTMLAudioElement;
  // Actual volume-controlled playback goes through Web Audio:
  //   MediaStreamAudioSourceNode → gainNode → ctx.destination   (playback)
  //   MediaStreamAudioSourceNode → analyser                     (speaking detection)
  // GainNode.gain is not capped at 1.0, so the full 0.5–5× slider range works.
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
  // audioBlocked: suspended context, user tap will fix it.
  // audioInterrupted: exclusive hardware use (phone call etc), user cannot fix it —
  //   the OS will restore it when the interruption ends.
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [audioInterrupted, setAudioInterrupted] = useState(false);

  const localStream = useRef<MediaStream | null>(null); // RNNoise-processed stream → sent over WebRTC
  const rawMicStream = useRef<MediaStream | null>(null); // raw getUserMedia stream → stop() on cleanup
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

  // socketRef keeps the first useEffect's closure always holding the current
  // socket, avoiding a stale-null capture since that effect has [] deps.
  const socketRef = useRef(socket);
  socketRef.current = socket;

  const remotePlayersRef = useRef(remotePlayers);
  remotePlayersRef.current = remotePlayers;
  const remoteGainRef = useRef(remoteGain);
  remoteGainRef.current = remoteGain;

  const wasLocalSpeaking = useRef(false);
  const wasSpeakingPeers = useRef(new Set<string>());

  // Acquire mic and set up local speaking analyser.
  useEffect(() => {
    // AudioContext must be created eagerly so ICE/peer setup can reference it,
    // but iOS Safari keeps it in "suspended" until a user-gesture resume() call,
    // and can enter "interrupted" when a phone call takes over audio hardware.
    const ctx = new AudioContextCtor();
    audioCtx.current = ctx;
    void ctx.resume().catch(() => {/* ignored — will retry on gesture */});

    ctx.onstatechange = () => {
      const hasPeers = peers.current.size > 0;
      setAudioInterrupted(ctx.state === "interrupted" && hasPeers);
      setAudioBlocked(ctx.state === "suspended" && hasPeers);
    };

    const resumeOnGesture = () => {
      // "interrupted" means exclusive audio hardware use (e.g. phone call) —
      // resume() would throw InvalidStateError, so skip it in that state.
      // The context will transition back to "running" on its own when the
      // interruption ends and onstatechange will clear the banner.
      if (ctx.state !== "interrupted") {
        void ctx.resume().catch(() => {/* Safari may still throw — swallow it */});
      }
    };

    const resumeOnVisibility = () => {
      // Mobile browsers suspend AudioContext when the tab goes to the
      // background. Resume as soon as the tab is visible again.
      if (!document.hidden && ctx.state === "suspended") {
        void ctx.resume().catch(() => {});
      }
    };

    // iOS Safari: "play-and-record" maps to AVAudioSessionCategoryPlayAndRecord
    // so the mic and speaker can both be active. The loudspeaker override is
    // handled separately via the non-muted audio element trick in getOrCreatePeer.
    if ("audioSession" in navigator) {
      (navigator as unknown as { audioSession: { type: string } }).audioSession.type =
        "play-and-record";
    }

    if (navigator.mediaDevices) {
      navigator.mediaDevices
        .getUserMedia(AUDIO_CONSTRAINTS)
        .then(async (rawStream) => {
          // Keep the raw hardware stream separate so we can stop the mic
          // tracks on cleanup regardless of whether RNNoise is active.
          rawMicStream.current = rawStream;

          // Apply RNNoise noise suppression. On failure the raw stream is
          // returned as a transparent fallback so voice still works.
          const processedStream = await applyNoiseSuppression(ctx, rawStream);
          localStream.current = processedStream;

          setIsMicReady(true);
          // ctx.resume() here is outside a user-gesture on iOS and is silently
          // ignored; the gesture handlers above are the reliable resume path.
          void ctx.resume().catch(() => {/* will resume on next gesture */});

          // Connect the processed stream to the speaking-detection analyser.
          // Using the denoised signal reduces false-positives from background noise.
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          ctx.createMediaStreamSource(processedStream).connect(analyser);
          localAnalyser.current = analyser;

          // Attach mic tracks to peers that were created while permission was
          // pending, and renegotiate so they receive our audio.
          // socketRef.current — NOT the closure-captured `socket` — ensures we
          // always use the live socket even though this effect has [] deps.
          peers.current.forEach(({ connection }, peerId) => {
            attachLocalTracks(connection, processedStream);
            const liveSocket = socketRef.current;
            if (liveSocket) {
              void renegotiatePeer(peerId, liveSocket);
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
    document.addEventListener("visibilitychange", resumeOnVisibility);

    return () => {
      window.removeEventListener("pointerdown", resumeOnGesture);
      window.removeEventListener("keydown", resumeOnGesture);
      window.removeEventListener("touchstart", resumeOnGesture);
      document.removeEventListener("visibilitychange", resumeOnVisibility);
      [...peers.current.keys()].forEach((peerId) => {
        closePeer(peerId, { emitHangup: false, reason: "hook cleanup" });
      });
      peers.current.clear();
      connectingPeers.current.clear();
      disconnectTimers.current.forEach((timerId) => window.clearTimeout(timerId));
      disconnectTimers.current.clear();
      // Stop the raw hardware mic tracks (not the processed stream, which
      // is a synthetic MediaStreamDestinationNode output with no hardware).
      rawMicStream.current?.getTracks().forEach((track) => track.stop());
      // Closing the AudioContext also destroys the RNNoise worklet and all nodes.
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
      // Keep audioBlocked/audioInterrupted in sync (onstatechange handles it
      // too, but this catches cases where the state changes between events).
      const ctxState = audioCtx.current?.state;
      const hasPeers = peers.current.size > 0;
      setAudioInterrupted(ctxState === "interrupted" && hasPeers);
      setAudioBlocked(ctxState === "suspended" && hasPeers);
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

    // Firefox can't resolve Chrome's mDNS `.local` ICE candidates, so it needs
    // a TURN relay even when Chrome (on the same LAN) doesn't.
    const iceServers = IS_FIREFOX ? ICE_SERVERS_FIREFOX : ICE_SERVERS_DEFAULT;
    const pc = new RTCPeerConnection({ iceServers });
    const ctx = audioCtx.current;
    if (!ctx) {
      throw new Error("Audio context is not ready");
    }

    // Chrome workaround: WebRTC remote streams only flow through
    // createMediaStreamSource() if the stream is also attached to an
    // HTMLAudioElement. On non-iOS we keep it muted so the Web Audio graph is
    // the sole audible output.
    //
    // iOS loudspeaker trick: iOS routes AVAudioSessionCategoryPlayAndRecord to
    // the earpiece by default. The only JS-level override is to keep a non-muted
    // audio element playing (even at volume=0). iOS then treats the page as a
    // media-playback app and routes the entire audio session to the loudspeaker.
    const audio = new Audio();
    audio.muted = !IS_IOS;   // non-muted on iOS forces loudspeaker routing
    audio.volume = 0;        // silent on iOS; Web Audio graph handles output
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");

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

      // Step 1 — Chrome workaround: attach the stream to the muted audio element.
      // This activates Chrome's internal WebRTC audio pipeline; without this,
      // createMediaStreamSource() produces no samples in Chrome.
      // The element is muted so it emits no sound — only the Web Audio graph below
      // is audible.
      entry.audio.srcObject = stream;
      void entry.audio.play().catch(() => {
        // Muted autoplay is universally allowed; this catch is a safety net only.
        console.warn(`[voice] muted audio.play() failed for ${peerId}`);
      });

      if (!entry.analyserSource) {
        // Step 2 — Web Audio graph for gain-controlled output and speaking detection.
        //   source → gainNode → ctx.destination  (audible, gain can exceed 1.0)
        //   source → analyser                    (speaking detection, no output)
        const source = ctx.createMediaStreamSource(stream);
        source.connect(entry.gainNode);
        source.connect(entry.analyser);
        entry.analyserSource = source;
      }
    };

    peers.current.set(peerId, {
      connection: pc,
      audio,
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
    entry.audio.pause();
    entry.audio.srcObject = null;

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

    // Wait for a stable signaling state before renegotiating (up to 3 s).
    // If we bail immediately when not-stable, the peer never sends local audio
    // tracks — causing one-sided audio where A hears B but B hears nothing.
    let waited = 0;
    while (entry.connection.signalingState !== "stable") {
      if (!peers.current.has(peerId)) return; // peer closed while waiting
      if (waited >= 3000) {
        console.warn(`[rtc] renegotiation timed out waiting for stable state (${peerId})`);
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      waited += 200;
    }

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
    audioInterrupted,
  };
}

// Loads the RNNoise AudioWorklet into the given AudioContext and routes the
// raw mic stream through it, returning a new processed MediaStream.
// Signal graph:
//   raw mic source → NoiseSuppressorWorkletNode → MediaStreamDestinationNode
//                                                         ↓
//                                               processed .stream (→ WebRTC)
// Falls back to the raw stream transparently if the worklet fails to load
// (e.g. browser blocks WASM, or very old Safari).
async function applyNoiseSuppression(
  ctx: AudioContext,
  rawStream: MediaStream,
): Promise<MediaStream> {
  try {
    await ctx.audioWorklet.addModule(NoiseSuppressorWorkletUrl);
    const source = ctx.createMediaStreamSource(rawStream);
    const rnnoiseNode = new AudioWorkletNode(ctx, NoiseSuppressorWorklet_Name);
    const destination = ctx.createMediaStreamDestination();
    source.connect(rnnoiseNode).connect(destination);
    console.log("[voice] RNNoise noise suppression active");
    return destination.stream;
  } catch (err) {
    console.warn("[voice] RNNoise worklet failed — using raw mic stream:", err);
    return rawStream;
  }
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
      console.warn("[voice] VITE_ICE_SERVERS_JSON is not a non-empty array — ignoring");
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
      { urls: turnUrl, username: turnUsername, credential: turnCredential },
    ];
  }

  return DEFAULT_ICE_SERVERS;
}

// Firefox cannot resolve Chrome's mDNS `.local` ICE candidates (privacy
// obfuscation introduced in Chrome 75). Cross-browser LAN connections silently
// fail with "ICE failed" unless a TURN relay is present. This config always
// includes the TURN server when credentials are available, ensuring Firefox can
// reach Chrome peers via relay even when direct candidates are unreachable.
// If no TURN credentials are configured a console warning is emitted so it is
// visible in dev tools on Firefox.
function resolveIceServersForFirefox(): RTCIceServer[] {
  const env = import.meta.env as Record<string, string | undefined>;

  // If the caller supplied a full ICE server list, use it as-is — they are
  // responsible for including a TURN entry.
  const json = env.VITE_ICE_SERVERS_JSON;
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as RTCIceServer[];
      }
    } catch {
      // fall through to individual env vars
    }
  }

  const turnUrl = env.VITE_TURN_URL;
  const turnUsername = env.VITE_TURN_USERNAME;
  const turnCredential = env.VITE_TURN_CREDENTIAL;
  if (turnUrl && turnUsername && turnCredential) {
    return [
      ...DEFAULT_ICE_SERVERS,
      { urls: turnUrl, username: turnUsername, credential: turnCredential },
    ];
  }

  // No TURN configured: Firefox will likely fail to connect to Chrome peers on
  // the same LAN. Add VITE_TURN_URL / VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL
  // (or VITE_ICE_SERVERS_JSON) to fix this.
  console.warn(
    "[voice] Firefox detected but no TURN server is configured. " +
    "Cross-browser connections on the same LAN may fail with 'ICE failed'. " +
    "Set VITE_TURN_URL, VITE_TURN_USERNAME, and VITE_TURN_CREDENTIAL.",
  );
  return DEFAULT_ICE_SERVERS;
}

function loadRemoteGain(): number {
  try {
    const raw = localStorage.getItem(GAIN_STORAGE_KEY);
    // Mobile speakers need more drive than desktop headphones/monitors.
    if (!raw) return IS_MOBILE ? 3.0 : 1;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) return IS_MOBILE ? 3.0 : 1;
    return Math.min(5, Math.max(0.5, parsed));
  } catch {
    return IS_MOBILE ? 1.5 : 1;
  }
}
