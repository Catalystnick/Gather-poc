// LiveKit-based proximity voice
// Uses LiveKit room with selective subscription based on distance.
// Mic processing: getUserMedia (browser AEC/NS/AGC) → gain → publish → Krisp noise filter.

import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { RemotePlayer } from "../types";
import {
  Room,
  RoomEvent,
  Track,
  AudioPresets,
  LocalAudioTrack,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type RemoteAudioTrack,
} from "livekit-client";
import { KrispNoiseFilter, isKrispNoiseFilterSupported } from "@livekit/krisp-noise-filter";

// Krisp requires a real hardware MediaStreamTrack — publishing a MediaStreamDestination
// output causes OverconstrainedError because synthetic tracks have no hardware capabilities
// for applyConstraints(). This processor chains: hardware track → Krisp NC → gain node →
// published, so both noise cancellation and mic gain control work correctly.
type AudioProcessorOpts = {
  kind: Track.Kind;
  track: MediaStreamTrack;
  audioContext: AudioContext;
  element?: HTMLMediaElement;
};

class GainKrispProcessor {
  readonly name = "gain-krisp";
  processedTrack?: MediaStreamTrack;
  private krisp: ReturnType<typeof KrispNoiseFilter>;
  private gainNode: GainNode;
  private micSourceNode: MediaStreamAudioSourceNode;
  private destNode?: MediaStreamAudioDestinationNode;

  constructor(gainNode: GainNode, micSourceNode: MediaStreamAudioSourceNode) {
    this.krisp = KrispNoiseFilter();
    this.gainNode = gainNode;
    this.micSourceNode = micSourceNode;
  }

  async init(opts: AudioProcessorOpts): Promise<void> {
    console.log("[Krisp] Initialising GainKrispProcessor with hardware track:", opts.track);
    await this.krisp.init(opts as Parameters<typeof this.krisp.init>[0]);

    const krispOut = this.krisp.processedTrack;
    if (!krispOut) throw new Error("[GainKrispProcessor] Krisp did not produce a processedTrack after init");

    // Use the gain node's own AudioContext — LiveKit supplies its own context in opts
    // which is different from the main audioCtx, so mixing them causes InvalidAccessError.
    const ctx = this.gainNode.context as AudioContext;

    // Disconnect raw mic source from gain node — Krisp output will drive it instead
    try { this.micSourceNode.disconnect(this.gainNode); } catch { /* already disconnected */ }

    // Chain: Krisp output → gain node → final published destination (all in same context)
    this.destNode = ctx.createMediaStreamDestination();
    ctx
      .createMediaStreamSource(new MediaStream([krispOut]))
      .connect(this.gainNode)
      .connect(this.destNode);

    this.processedTrack = this.destNode.stream.getAudioTracks()[0];
    console.log("[Krisp] Pipeline ready: hardware → Krisp NC → gain node → published. processedTrack:", this.processedTrack);
  }

  async restart(opts: AudioProcessorOpts): Promise<void> {
    console.log("[Krisp] Restarting processor with new track:", opts.track);
    await this.destroy();
    await this.init(opts);
  }

  async destroy(): Promise<void> {
    await this.krisp.destroy();
    // Restore original routing so the gain node is usable if the room reconnects
    try { this.micSourceNode.connect(this.gainNode); } catch { /* ignore */ }
    this.destNode = undefined;
    this.processedTrack = undefined;
    console.log("[Krisp] Processor destroyed, mic→gain routing restored.");
  }
}

const CONNECT_RANGE = 7;
const DISCONNECT_RANGE = 9;
const SPEAKING_THRESHOLD = 35; // Raised from 20 — Mac mics often have higher noise floor
const SPEAKING_HYSTERESIS_UP = 2;   // frames above threshold before showing green
const SPEAKING_HYSTERESIS_DOWN = 5; // frames below threshold before hiding green
const MIN_GAIN_FLOOR = 0.15;
const MAX_ACTIVE_PEERS = 8;
const GAIN_STORAGE_KEY = "gather_poc_remote_gain";
const MIC_GAIN_STORAGE_KEY = "gather_poc_mic_gain";
const ROLLOFF_STORAGE_KEY = "gather_poc_rolloff";
const DEFAULT_ROLLOFF = 1.4;
const AUDIO_SETTINGS_VERSION_KEY = "gather_poc_audio_settings_version";
const AUDIO_SETTINGS_VERSION = "2026-03-native-v1"; // bumped: drops legacy gate/rnnoise settings
const MIC_DUCKING_FACTOR = 0.25;
const MIC_DUCK_ATTACK_TC = 0.02;
const MIC_DUCK_RELEASE_TC = 0.14;
const ROOM_NAME = "gather-world";

const IS_MOBILE = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
  typeof navigator !== "undefined" ? navigator.userAgent : "",
);
const IS_FIREFOX = /Firefox\//i.test(
  typeof navigator !== "undefined" ? navigator.userAgent : "",
);
const DEFAULT_AGC_ENABLED = true;

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

function resolveIceServersForFirefox(): RTCIceServer[] {
  const env = import.meta.env as Record<string, string | undefined>;
  const json = env.VITE_ICE_SERVERS_JSON;
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as RTCIceServer[];
    } catch {
      /* fall through */
    }
  }
  const turnUrl = env.VITE_TURN_URL;
  const turnUsername = env.VITE_TURN_USERNAME;
  const turnCredential = env.VITE_TURN_CREDENTIAL;
  if (turnUrl && turnUsername && turnCredential) {
    return [...DEFAULT_ICE_SERVERS, { urls: turnUrl, username: turnUsername, credential: turnCredential }];
  }
  console.warn(
    "[voice] Firefox detected. Firefox↔Chromium audio may fail without TURN. " +
      "Set VITE_TURN_URL, VITE_TURN_USERNAME, VITE_TURN_CREDENTIAL (or VITE_ICE_SERVERS_JSON).",
  );
  return DEFAULT_ICE_SERVERS;
}

const AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: DEFAULT_AGC_ENABLED,
  } as MediaTrackConstraints,
  video: false,
};

const AudioContextCtor: typeof AudioContext =
  window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

let audioSettingsMigrationChecked = false;

interface RemoteEntry {
  participant: RemoteParticipant;
  track: RemoteAudioTrack;
  audio: HTMLAudioElement;
  gainNode: GainNode | null; // null on desktop — native <audio> volume preserves browser AEC reference
  analyser: AnalyserNode | null;
  analyserSource: MediaStreamAudioSourceNode | null;
}

function getTokenUrl(): string {
  const base = (import.meta.env as { VITE_SERVER_URL?: string }).VITE_SERVER_URL || "";
  return `${base || window.location.origin}/livekit/token`;
}

function distance(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function rmsOf(data: Uint8Array): number {
  return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
}

function loadRemoteGain(): number {
  ensureAudioSettingsMigration();
  try {
    const raw = localStorage.getItem(GAIN_STORAGE_KEY);
    if (!raw) return IS_MOBILE ? 3.0 : 1;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) return IS_MOBILE ? 3.0 : 1;
    return Math.max(0, parsed);
  } catch {
    return IS_MOBILE ? 1.5 : 1;
  }
}

function loadMicGain(): number {
  ensureAudioSettingsMigration();
  try {
    const raw = localStorage.getItem(MIC_GAIN_STORAGE_KEY);
    if (!raw) return IS_MOBILE ? 2.0 : 1;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) return IS_MOBILE ? 2.0 : 1;
    return Math.max(0, parsed);
  } catch {
    return IS_MOBILE ? 2.0 : 1;
  }
}

function loadRolloff(): number {
  ensureAudioSettingsMigration();
  try {
    const raw = localStorage.getItem(ROLLOFF_STORAGE_KEY);
    if (!raw) return DEFAULT_ROLLOFF;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) return DEFAULT_ROLLOFF;
    return Math.max(0.1, parsed);
  } catch {
    return DEFAULT_ROLLOFF;
  }
}

function ensureAudioSettingsMigration() {
  if (audioSettingsMigrationChecked) return;
  audioSettingsMigrationChecked = true;
  try {
    if (localStorage.getItem(AUDIO_SETTINGS_VERSION_KEY) === AUDIO_SETTINGS_VERSION) return;
    localStorage.removeItem(GAIN_STORAGE_KEY);
    localStorage.removeItem(MIC_GAIN_STORAGE_KEY);
    localStorage.removeItem(ROLLOFF_STORAGE_KEY);
    // Clean up legacy gate/rnnoise keys
    localStorage.removeItem("gather_poc_gate_threshold");
    localStorage.removeItem("gather_poc_rnnoise");
    localStorage.setItem(AUDIO_SETTINGS_VERSION_KEY, AUDIO_SETTINGS_VERSION);
  } catch {
    /* storage unavailable */
  }
}

export function useLiveKitVoice(
  socket: Socket | null,
  playerName: string,
  localPositionRef: React.MutableRefObject<{ x: number; y: number; z: number }>,
  remotePlayers: Map<string, RemotePlayer>,
) {
  const [muted, setMuted] = useState(false);
  const [isLocalSpeaking, setIsLocalSpeaking] = useState(false);
  const [speakingPeers, setSpeakingPeers] = useState<Set<string>>(new Set());
  const [connectedPeers, setConnectedPeers] = useState<Set<string>>(new Set());
  const [peerConnectionStates, setPeerConnectionStates] = useState<Record<string, string>>({});
  const [remoteGain, setRemoteGain] = useState(loadRemoteGain());
  const [micGain, setMicGainState] = useState(loadMicGain());
  const [rolloff] = useState(loadRolloff());
  const [echoCancelEnabled, setEchoCancelEnabledState] = useState(true);
  const [headphonePrompt, setHeadphonePrompt] = useState<string | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [audioInterrupted, setAudioInterrupted] = useState(false);
  const [roomReady, setRoomReady] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const rawMicStream = useRef<MediaStream | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const micGainNode = useRef<GainNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const localAnalyser = useRef<AnalyserNode | null>(null);
  const remoteEntries = useRef<Map<string, RemoteEntry>>(new Map());
  const [isMicReady, setIsMicReady] = useState(false);
  const subscribedIdentities = useRef<Set<string>>(new Set());
  const wasLocalSpeaking = useRef(false);
  const wasSpeakingPeers = useRef(new Set<string>());
  const localSpeakingFrames = useRef(0); // hysteresis: consecutive frames above/below threshold
  const prevOutputDeviceIdsRef = useRef<Set<string>>(new Set());
  const headphoneDeviceIdRef = useRef<string | null>(null);

  const remotePlayersRef = useRef(remotePlayers);
  remotePlayersRef.current = remotePlayers;
  const remoteGainRef = useRef(remoteGain);
  remoteGainRef.current = remoteGain;
  const rolloffRef = useRef(rolloff);
  rolloffRef.current = rolloff;
  const echoCancelEnabledRef = useRef(echoCancelEnabled);
  echoCancelEnabledRef.current = echoCancelEnabled;
  const micGainRef = useRef(micGain);
  micGainRef.current = micGain;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const playerNameRef = useRef(playerName);
  playerNameRef.current = playerName;
  const micDuckedRef = useRef(false);

  function applyEffectiveMicGain(baseGain: number, shouldDuck: boolean) {
    const ctx = audioCtx.current;
    const gainNode = micGainNode.current;
    if (!ctx || !gainNode) return;
    const effectiveBase = mutedRef.current ? 0 : baseGain;
    const targetGain = shouldDuck ? effectiveBase * MIC_DUCKING_FACTOR : effectiveBase;
    gainNode.gain.setTargetAtTime(
      targetGain,
      ctx.currentTime,
      shouldDuck ? MIC_DUCK_ATTACK_TC : MIC_DUCK_RELEASE_TC,
    );
    micDuckedRef.current = shouldDuck && effectiveBase > 0;
  }

  // Mic setup — browser-native noiseSuppression + echoCancellation + AGC via getUserMedia constraints
  useEffect(() => {
    const ctx = new AudioContextCtor();
    audioCtx.current = ctx;
    void ctx.resume().catch(() => {});

    ctx.onstatechange = () => {
      const hasPeers = remoteEntries.current.size > 0;
      setAudioInterrupted(ctx.state === "interrupted" && hasPeers);
      setAudioBlocked(ctx.state === "suspended" && hasPeers);
    };

    const resumeOnGesture = () => {
      if (ctx.state !== "interrupted") {
        void ctx.resume().catch(() => {});
      }
      // LiveKit: startAudio() must be called from a user gesture when autoplay is blocked
      void roomRef.current?.startAudio?.().catch(() => {});
      remoteEntries.current.forEach((entry) => {
        if (entry.audio.paused && entry.audio.srcObject) {
          void entry.audio.play().catch(() => {});
        }
      });
    };

    const resumeOnVisibility = () => {
      if (!document.hidden && ctx.state === "suspended") {
        void ctx.resume().catch(() => {});
      }
    };

    if ("audioSession" in navigator) {
      (navigator as unknown as { audioSession: { type: string } }).audioSession.type = "play-and-record";
    }

    if (!navigator.mediaDevices) {
      console.warn("[voice] mediaDevices unavailable");
      return;
    }

    navigator.mediaDevices
      .getUserMedia(AUDIO_CONSTRAINTS)
      .then(async (rawStream) => {
        rawMicStream.current = rawStream;

        const gainNode = ctx.createGain();
        gainNode.gain.value = loadMicGain();
        micGainNode.current = gainNode;

        const micSource = ctx.createMediaStreamSource(rawStream);
        micSourceRef.current = micSource;
        const micDest = ctx.createMediaStreamDestination();
        micSource.connect(gainNode).connect(micDest);
        localStream.current = micDest.stream;

        if (IS_MOBILE && "setSinkId" in ctx) {
          try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const outputs = devices.filter((d) => d.kind === "audiooutput");
            const speaker = outputs.find((d) => /speaker/i.test(d.label) && !/ear/i.test(d.label)) ?? outputs[0];
            if (speaker) {
              await (ctx as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(speaker.deviceId);
            }
          } catch {
            /* non-fatal */
          }
        }

        setIsMicReady(true);
        void ctx.resume().catch(() => {});

        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        ctx.createMediaStreamSource(rawStream).connect(analyser);
        localAnalyser.current = analyser;
      })
      .catch((err) => console.warn("[voice] mic denied:", err));

    window.addEventListener("pointerdown", resumeOnGesture);
    window.addEventListener("keydown", resumeOnGesture);
    window.addEventListener("touchstart", resumeOnGesture, { passive: true });
    document.addEventListener("visibilitychange", resumeOnVisibility);

    return () => {
      window.removeEventListener("pointerdown", resumeOnGesture);
      window.removeEventListener("keydown", resumeOnGesture);
      window.removeEventListener("touchstart", resumeOnGesture);
      document.removeEventListener("visibilitychange", resumeOnVisibility);
      rawMicStream.current?.getTracks().forEach((t) => t.stop());
      micSourceRef.current = null;
      void ctx.close();
    };
  }, []);

  // Headphone detection
  useEffect(() => {
    if (!navigator.mediaDevices?.addEventListener) return;
    let disposed = false;
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      if (disposed) return;
      prevOutputDeviceIdsRef.current = new Set(
        devices.filter((d) => d.kind === "audiooutput").map((d) => d.deviceId),
      );
    }).catch(() => {});

    async function handleDeviceChange() {
      if (disposed) return;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter((d) => d.kind === "audiooutput");
        const newIds = new Set(outputs.map((d) => d.deviceId));
        const appeared = outputs.filter(
          (d) =>
            !prevOutputDeviceIdsRef.current.has(d.deviceId) &&
            d.deviceId !== "default" &&
            d.deviceId !== "communications",
        );
        const disappearedIds = [...prevOutputDeviceIdsRef.current].filter((id) => !newIds.has(id));
        prevOutputDeviceIdsRef.current = newIds;

        const confirmedId = headphoneDeviceIdRef.current;
        if (confirmedId && disappearedIds.includes(confirmedId)) {
          headphoneDeviceIdRef.current = null;
          if (!echoCancelEnabledRef.current) {
            setEchoCancelEnabledState(true);
            const track = rawMicStream.current?.getAudioTracks()[0];
            if (track) {
              try {
                await track.applyConstraints({ echoCancellation: true });
              } catch {
                /* ignore */
              }
            }
          }
        }

        if (appeared.length > 0) {
          const device = appeared[0];
          headphoneDeviceIdRef.current = device.deviceId;
          setHeadphonePrompt(device.label || "New audio device");
        }
      } catch {
        /* ignore */
      }
    }

    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => {
      disposed = true;
      navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, []);

  // Connect to LiveKit when socket is ready
  useEffect(() => {
    if (!socket?.id || !isMicReady || !localStream.current) return;

    const identity = socket.id;
    let room: Room | null = null;
    const cleanupRemoteEntry = (participantIdentity: string) => {
      const entry = remoteEntries.current.get(participantIdentity);
      if (!entry) return;
      if (entry.analyserSource) entry.analyserSource.disconnect();
      entry.gainNode?.disconnect();
      entry.track.detach().forEach((el) => el.remove());
      entry.audio.remove();
      remoteEntries.current.delete(participantIdentity);
    };
    const cleanupAllRemoteEntries = () => {
      [...remoteEntries.current.keys()].forEach((participantIdentity) =>
        cleanupRemoteEntry(participantIdentity),
      );
    };

    async function connect() {
      try {
        const res = await fetch(getTokenUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            roomName: ROOM_NAME,
            identity,
            name: playerNameRef.current || identity,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Token ${res.status}`);
        }
        const { token, url } = await res.json();
        if (!token || !url) throw new Error("Invalid token response");

        room = new Room({
          adaptiveStream: false,
          dynacast: false,
          singlePeerConnection: true, // Helps Firefox↔Chromium; some setups fail with dual PC
          webAudioMix: false, // Use HTMLAudioElement for playback — required for AEC, more reliable Firefox→Chromium
          audioCaptureDefaults: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: DEFAULT_AGC_ENABLED,
          },
        });
        (
          room as Room & {
            setMaxListeners?: (listenerCount: number) => void;
          }
        ).setMaxListeners?.(32);

        room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
          if (track.kind !== Track.Kind.Audio) return;
          const ctx = audioCtx.current;
          if (!ctx) return;

          cleanupRemoteEntry(participant.identity);
          const audioTrack = track as RemoteAudioTrack;
          // Use LiveKit's attach() — more reliable Firefox→Chromium than custom Web Audio pipeline
          const audio = audioTrack.attach();
          audio.autoplay = true;
          audio.setAttribute("playsinline", "true");
          audio.style.display = "none"; // In DOM so Chromium plays; hidden
          document.body.appendChild(audio);
          audioTrack.setVolume(1);

          // Desktop: play natively via <audio> element so the browser's AEC keeps its
          // output reference and can cancel speaker audio from the mic signal.
          // Mobile: route through Web Audio for >1.0 gain amplification (native volume is capped at 1).
          let gainNode: GainNode | null = null;
          if (IS_MOBILE) {
            gainNode = ctx.createGain();
            gainNode.gain.value = MIN_GAIN_FLOOR;
            ctx.createMediaElementSource(audio).connect(gainNode).connect(ctx.destination);
          } else {
            audio.volume = MIN_GAIN_FLOOR;
          }

          remoteEntries.current.set(participant.identity, {
            participant,
            track: audioTrack,
            audio,
            gainNode,
            analyser: null,
            analyserSource: null,
          });
          setPeerConnectionState(participant.identity, "connected");

          void audio.play().catch(() => {
            setAudioBlocked(true); // User must tap to enable playback
          });
        });

        room.on(RoomEvent.TrackUnsubscribed, (_track, _publication, participant) => {
          cleanupRemoteEntry(participant.identity);
          setPeerConnectionState(participant.identity, null);
        });

        room.on(RoomEvent.ParticipantDisconnected, (participant) => {
          cleanupRemoteEntry(participant.identity);
          setPeerConnectionState(participant.identity, null);
        });

        room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
          if (!room?.canPlaybackAudio) {
            setAudioBlocked(true);
          }
        });

        room.on(RoomEvent.Disconnected, () => {
          setRoomReady(false);
          roomRef.current = null;
          cleanupAllRemoteEntries();
          subscribedIdentities.current.clear();
          applyEffectiveMicGain(micGainRef.current, false);
          setConnectedPeers(new Set());
          setPeerConnectionStates({});
        });

        room.on(RoomEvent.Reconnecting, () => {
          setRoomReady(false);
        });

        room.on(RoomEvent.Reconnected, () => {
          setRoomReady(true);
        });

        const connectOpts: { autoSubscribe: boolean; rtcConfig?: RTCConfiguration } = {
          autoSubscribe: false,
        };
        if (IS_FIREFOX) {
          connectOpts.rtcConfig = { iceServers: resolveIceServersForFirefox() };
        }
        await room.connect(url, token, connectOpts);

        roomRef.current = room;
        if (audioCtx.current?.state === "running") {
          void room.startAudio().catch(() => {});
        }
        setRoomReady(true);

        // TrackPublished: subscribe only when a new participant publishes (must be registered
        // after connect, otherwise we miss tracks from participants who join after us)
        const handleTrackPublished = (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          if (publication.kind !== Track.Kind.Audio) return;
          const player = remotePlayersRef.current.get(participant.identity);
          if (!player) return;
          const dist = distance(localPositionRef.current, player.position);
          const candidates = [...remotePlayersRef.current.entries()]
            .map(([id, p]) => ({ id, distance: distance(localPositionRef.current, p.position) }))
            .filter((e) => e.distance < 9)
            .sort((a, b) => a.distance - b.distance);
          const preferred = new Set(candidates.slice(0, MAX_ACTIVE_PEERS).map((e) => e.id));
          if (dist < CONNECT_RANGE && preferred.has(participant.identity)) {
            publication.setSubscribed(true);
            subscribedIdentities.current.add(participant.identity);
          }
        };
        room.on(RoomEvent.TrackPublished, handleTrackPublished);

        // Publish our processed mic track
        // Safari on Mac keeps AudioContext suspended until user gesture — resume before publish
        // so the processing chain (gate, gain) actually flows audio. Without this, Mac sends silence.
        const ctx = audioCtx.current;
        if (ctx?.state === "suspended") {
          setAudioBlocked(true); // Show "Tap to enable" so user knows to interact
          await ctx.resume().catch(() => {});
        }
        // Publish the raw hardware track — Krisp requires a real getUserMedia track,
        // not a MediaStreamDestination output, to satisfy applyConstraints() internally.
        const micTrack = rawMicStream.current!.getAudioTracks()[0];
        console.log("[Krisp] Publishing raw hardware track:", micTrack);
        if (micTrack) {
          const publication = await room.localParticipant.publishTrack(micTrack, {
            source: Track.Source.Microphone,
            name: "mic",
            audioPreset: AudioPresets.musicStereo,
          });
          const krispSupported = isKrispNoiseFilterSupported();
          console.log("[Krisp] isKrispNoiseFilterSupported:", krispSupported);
          if (krispSupported && publication.track instanceof LocalAudioTrack) {
            const processor = new GainKrispProcessor(micGainNode.current!, micSourceRef.current!);
            try {
              await publication.track.setProcessor(processor as unknown as Parameters<typeof publication.track.setProcessor>[0]);
              console.log("[Krisp] setProcessor complete. processedTrack:", processor.processedTrack);
            } catch (err) {
              console.error("[Krisp] Failed to set processor:", err);
            }
          } else if (!krispSupported) {
            console.warn("[Krisp] Not supported in this environment (requires LiveKit Cloud).");
          } else {
            console.warn("[Krisp] Track is not a LocalAudioTrack, skipping. Track:", publication.track);
          }
        }

        // Subscribe to existing participants in range (will be updated by proximity loop)
        for (const participant of room.remoteParticipants.values()) {
          const dist = getDistanceForIdentity(participant.identity);
          if (dist !== null && dist < DISCONNECT_RANGE) {
            for (const pub of participant.trackPublications.values()) {
              if (pub.kind === Track.Kind.Audio && !pub.isSubscribed) {
                (pub as RemoteTrackPublication).setSubscribed(true);
                subscribedIdentities.current.add(participant.identity);
              }
            }
          }
        }
      } catch (err) {
        console.warn("[voice] LiveKit connect failed:", err);
      }
    }

    function getDistanceForIdentity(identity: string): number | null {
      const player = remotePlayersRef.current.get(identity);
      if (!player) return null;
      return distance(localPositionRef.current, player.position);
    }

    void connect();

    return () => {
      setRoomReady(false);
      if (room) {
        room.disconnect();
        roomRef.current = null;
      }
      cleanupAllRemoteEntries();
      subscribedIdentities.current.clear();
      applyEffectiveMicGain(micGainRef.current, false);
    };
  }, [socket?.id, isMicReady]);

  // Proximity loop: subscribe/unsubscribe + distance gain + speaking
  useEffect(() => {
    if (!roomReady) return;
    const room = roomRef.current;
    if (!room) return;

    const dataArray = new Uint8Array(128);

    const interval = setInterval(() => {
      const local = localPositionRef.current;
      const remote = remotePlayersRef.current;
      const ctx = audioCtx.current;

      // Local speaking with hysteresis — avoids Mac false positives from mic noise floor
      if (localAnalyser.current) {
        localAnalyser.current.getByteFrequencyData(dataArray);
        const above = rmsOf(dataArray) > SPEAKING_THRESHOLD;
        if (above) {
          localSpeakingFrames.current = Math.min(
            SPEAKING_HYSTERESIS_UP,
            localSpeakingFrames.current + 1,
          );
        } else {
          localSpeakingFrames.current = Math.max(
            -SPEAKING_HYSTERESIS_DOWN,
            localSpeakingFrames.current - 1,
          );
        }
        const speaking = !mutedRef.current && (
          localSpeakingFrames.current >= SPEAKING_HYSTERESIS_UP ||
          (wasLocalSpeaking.current && localSpeakingFrames.current > -SPEAKING_HYSTERESIS_DOWN)
        );
        wasLocalSpeaking.current = speaking;
        setIsLocalSpeaking(speaking);
      }

      const candidates = [...remote.entries()]
        .map(([id, player]) => ({ id, player, distance: distance(local, player.position) }))
        .filter((e) => e.distance < DISCONNECT_RANGE)
        .sort((a, b) => a.distance - b.distance);
      const preferredIds = new Set(candidates.slice(0, MAX_ACTIVE_PEERS).map((e) => e.id));

      // Unsubscribe from participants no longer in range or left room
      for (const identity of subscribedIdentities.current) {
        const player = remote.get(identity);
        const dist = player ? distance(local, player.position) : Infinity;
        if (!player || dist > DISCONNECT_RANGE) {
          const participant = room.remoteParticipants.get(identity);
          if (participant) {
            for (const pub of participant.trackPublications.values()) {
              if (pub.kind === Track.Kind.Audio && pub.isSubscribed) {
                (pub as RemoteTrackPublication).setSubscribed(false);
              }
            }
          }
          subscribedIdentities.current.delete(identity);
        }
      }

      const nextSpeaking = new Set<string>();

      // Subscribe to participants in range
      remote.forEach((player, id) => {
        const dist = distance(local, player.position);
        const preferred = preferredIds.has(id);
        const subscribed = subscribedIdentities.current.has(id);

        if (dist < CONNECT_RANGE && preferred && !subscribed) {
          const participant = room.remoteParticipants.get(id);
          if (participant) {
            for (const pub of participant.trackPublications.values()) {
              if (pub.kind === Track.Kind.Audio && !pub.isSubscribed) {
                (pub as RemoteTrackPublication).setSubscribed(true);
                subscribedIdentities.current.add(id);
              }
            }
          }
        } else if (subscribed) {
          const entry = remoteEntries.current.get(id);
          if (!entry || !ctx) return;

          const userGain = remoteGainRef.current;
          const normalized = Math.min(1, Math.max(0, dist / DISCONNECT_RANGE));
          const distanceFactor = 1 - normalized ** rolloffRef.current;
          const targetGain = distanceFactor * userGain;
          if (entry.gainNode) {
            entry.gainNode.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.05);
          } else {
            entry.audio.volume = Math.min(1, targetGain);
          }

          // Use LiveKit's server-side isSpeaking — more reliable across Mac/PC than our RMS
          if (entry.participant.isSpeaking) nextSpeaking.add(id);
        }
      });

      wasSpeakingPeers.current = nextSpeaking;
      setSpeakingPeers(nextSpeaking);
      const shouldDuck = nextSpeaking.size > 0 && !headphoneDeviceIdRef.current;
      applyEffectiveMicGain(micGainRef.current, shouldDuck);
      setConnectedPeers(new Set(subscribedIdentities.current));
      const ctxState = audioCtx.current?.state;
      const hasPeers = remoteEntries.current.size > 0;
      const livekitBlocked = hasPeers && roomRef.current != null && !roomRef.current.canPlaybackAudio;
      setAudioInterrupted(ctxState === "interrupted" && hasPeers);
      setAudioBlocked((ctxState === "suspended" || livekitBlocked) && hasPeers);
    }, 100);

    return () => clearInterval(interval);
  }, [roomReady]);

  function setPeerConnectionState(identity: string, state: string | null) {
    setPeerConnectionStates((prev) => {
      const next = { ...prev };
      if (state === null) {
        delete next[identity];
      } else {
        next[identity] = state;
      }
      return next;
    });
  }

  function toggleMute() {
    setMuted((prev) => {
      const next = !prev;
      mutedRef.current = next;
      rawMicStream.current?.getAudioTracks().forEach((t) => {
        t.enabled = !next;
      });
      if (next) {
        wasLocalSpeaking.current = false;
        localSpeakingFrames.current = 0;
        setIsLocalSpeaking(false);
      }
      applyEffectiveMicGain(micGainRef.current, micDuckedRef.current);
      return next;
    });
  }

  function updateRemoteGain(value: number) {
    const next = Math.max(0, value);
    setRemoteGain(next);
    try {
      localStorage.setItem(GAIN_STORAGE_KEY, String(next));
    } catch {
      /* ignore */
    }
  }

  function confirmHeadphones(accept: boolean) {
    setHeadphonePrompt(null);
    if (accept) {
      // Keep AEC enabled by default even with headphones. Auto-disabling can reintroduce
      // speaker loopback/echo on imperfect routing setups; users can still toggle manually.
      setEchoCancelEnabledState(true);
      echoCancelEnabledRef.current = true;
      void rawMicStream.current?.getAudioTracks()[0]?.applyConstraints({ echoCancellation: true }).catch(() => {});
    } else {
      headphoneDeviceIdRef.current = null;
    }
  }

  async function toggleEchoCancel() {
    const next = !echoCancelEnabledRef.current;
    setEchoCancelEnabledState(next);
    const track = rawMicStream.current?.getAudioTracks()[0];
    if (track) {
      try {
        await track.applyConstraints({ echoCancellation: next });
      } catch {
        /* ignore */
      }
    }
  }

  function updateMicGain(value: number) {
    const next = Math.max(0, value);
    setMicGainState(next);
    applyEffectiveMicGain(next, micDuckedRef.current);
    try {
      localStorage.setItem(MIC_GAIN_STORAGE_KEY, String(next));
    } catch {
      /* ignore */
    }
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
    micGain,
    setMicGain: updateMicGain,
    echoCancelEnabled,
    toggleEchoCancel,
    headphonePrompt,
    confirmHeadphones,
    audioBlocked,
    audioInterrupted,
  };
}
