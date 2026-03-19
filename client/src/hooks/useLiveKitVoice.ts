// LiveKit-based proximity voice
// Uses LiveKit room with selective subscription based on distance.
// Mic processing (RNnoise, VAD gate) preserved from P2P implementation.

import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { RemotePlayer } from "../types";
import {
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type RemoteAudioTrack,
} from "livekit-client";
import { MicVAD } from "@ricky0123/vad-web";
import { NoiseSuppressorWorklet_Name } from "@timephy/rnnoise-wasm";

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
const GATE_STORAGE_KEY = "gather_poc_gate_threshold";
const DEFAULT_GATE_THRESHOLD = 0;
const RNNOISE_STORAGE_KEY = "gather_poc_rnnoise";
const AUDIO_SETTINGS_VERSION_KEY = "gather_poc_audio_settings_version";
const AUDIO_SETTINGS_VERSION = "2026-03-standard-v1";
const GATE_ATTACK_TC = 0.003;
const GATE_RELEASE_TC = 0.08;
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

function loadGateThreshold(): number {
  ensureAudioSettingsMigration();
  try {
    const raw = localStorage.getItem(GATE_STORAGE_KEY);
    if (!raw) return DEFAULT_GATE_THRESHOLD;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) return DEFAULT_GATE_THRESHOLD;
    return Math.max(0, parsed);
  } catch {
    return DEFAULT_GATE_THRESHOLD;
  }
}

function loadRnnoiseEnabled(): boolean {
  ensureAudioSettingsMigration();
  try {
    const raw = localStorage.getItem(RNNOISE_STORAGE_KEY);
    if (!raw) return true;
    return raw === "1" || raw.toLowerCase() === "true";
  } catch {
    return true;
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
    localStorage.removeItem(GATE_STORAGE_KEY);
    localStorage.removeItem(RNNOISE_STORAGE_KEY);
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
  const [rolloff, setRolloffState] = useState(loadRolloff());
  const [gateThreshold, setGateThresholdState] = useState(loadGateThreshold());
  const [agcEnabled, setAgcEnabledState] = useState<boolean>(DEFAULT_AGC_ENABLED);
  const [echoCancelEnabled, setEchoCancelEnabledState] = useState(true);
  const [headphonePrompt, setHeadphonePrompt] = useState<string | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [audioInterrupted, setAudioInterrupted] = useState(false);
  const [rnnoiseEnabled, setRnnoiseEnabledState] = useState(loadRnnoiseEnabled());
  const [roomReady, setRoomReady] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const rawMicStream = useRef<MediaStream | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const micGainNode = useRef<GainNode | null>(null);
  const noiseGateNode = useRef<GainNode | null>(null);
  const gateIntervalIdRef = useRef<number | null>(null);
  const vadRef = useRef<MicVAD | null>(null);
  const rnnoiseNodeRef = useRef<AudioWorkletNode | null>(null);
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
  const gateThresholdRef = useRef(gateThreshold);
  gateThresholdRef.current = gateThreshold;
  const echoCancelEnabledRef = useRef(echoCancelEnabled);
  echoCancelEnabledRef.current = echoCancelEnabled;
  const rnnoiseEnabledRef = useRef(rnnoiseEnabled);
  rnnoiseEnabledRef.current = rnnoiseEnabled;
  const micGainRef = useRef(micGain);
  micGainRef.current = micGain;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
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

  // Mic setup (same pipeline as P2P: RNnoise, VAD gate, mic gain)
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

    const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
    const workletUrl = new URL("NoiseSuppressorWorklet.js", window.location.origin + base).href;
    const workletReady = ctx.audioWorklet
      .addModule(workletUrl)
      .then(() => true)
      .catch((err) => {
        console.warn("[voice] RNnoise worklet failed to load:", err);
        return false;
      });

    navigator.mediaDevices
      .getUserMedia(AUDIO_CONSTRAINTS)
      .then(async (rawStream) => {
        const rnnoiseAvailable = await workletReady;
        rawMicStream.current = rawStream;

        const gateNode = ctx.createGain();
        gateNode.gain.value = 1;
        noiseGateNode.current = gateNode;
        const gainNode = ctx.createGain();
        gainNode.gain.value = loadMicGain();
        micGainNode.current = gainNode;
        const micSource = ctx.createMediaStreamSource(rawStream);
        micSourceRef.current = micSource;
        const micDest = ctx.createMediaStreamDestination();
        const stereoMerger = ctx.createChannelMerger(2);
        // Duplicate mono mic into both L/R channels to avoid one-ear/mono regressions.
        gainNode.connect(stereoMerger, 0, 0);
        gainNode.connect(stereoMerger, 0, 1);
        stereoMerger.connect(micDest);

        const useRnnoise = loadRnnoiseEnabled() && rnnoiseAvailable;
        if (useRnnoise) {
          const rnnoiseNode = new AudioWorkletNode(ctx, NoiseSuppressorWorklet_Name);
          rnnoiseNodeRef.current = rnnoiseNode;
          micSource.connect(rnnoiseNode).connect(gateNode).connect(gainNode);
        } else {
          micSource.connect(gateNode).connect(gainNode);
        }
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

        const freqData = new Uint8Array(analyser.frequencyBinCount);
        const rmsGateTimer = window.setInterval(() => {
          const threshold = gateThresholdRef.current;
          const gate = noiseGateNode.current;
          if (!gate) return;
          if (threshold === 0) {
            if (gate.gain.value < 0.99) gate.gain.setTargetAtTime(1, ctx.currentTime, GATE_ATTACK_TC);
            return;
          }
          analyser.getByteFrequencyData(freqData);
          let sum = 0;
          for (let i = 0; i < freqData.length; i++) sum += freqData[i] * freqData[i];
          const rms = Math.sqrt(sum / freqData.length);
          if (rms > threshold) {
            gate.gain.setTargetAtTime(1, ctx.currentTime, GATE_ATTACK_TC);
          } else {
            gate.gain.setTargetAtTime(0, ctx.currentTime, GATE_RELEASE_TC);
          }
        }, 20);
        gateIntervalIdRef.current = rmsGateTimer;

        const posThresh = Math.max(0.01, gateThresholdRef.current / 100);
        MicVAD.new({
          audioContext: ctx,
          getStream: async () => rawStream,
          pauseStream: async () => {},
          resumeStream: async (stream) => stream,
          startOnLoad: false,
          baseAssetPath: "/",
          onnxWASMBasePath: "/",
          positiveSpeechThreshold: posThresh,
          negativeSpeechThreshold: Math.max(0.01, posThresh - 0.15),
          redemptionMs: 300,
          onSpeechStart: () => {
            if (gateThresholdRef.current === 0) return;
            const gate = noiseGateNode.current;
            if (gate) gate.gain.setTargetAtTime(1, ctx.currentTime, GATE_ATTACK_TC);
          },
          onSpeechEnd: () => {
            if (gateThresholdRef.current === 0) return;
            const gate = noiseGateNode.current;
            if (gate) gate.gain.setTargetAtTime(0, ctx.currentTime, GATE_RELEASE_TC);
          },
          onVADMisfire: () => {
            if (gateThresholdRef.current === 0) return;
            const gate = noiseGateNode.current;
            if (gate) gate.gain.setTargetAtTime(0, ctx.currentTime, GATE_RELEASE_TC);
          },
        })
          .then((vad) => {
            vadRef.current = vad;
            if (gateIntervalIdRef.current !== null) {
              window.clearInterval(gateIntervalIdRef.current);
              gateIntervalIdRef.current = null;
            }
            if (gateThresholdRef.current > 0 && noiseGateNode.current) {
              noiseGateNode.current.gain.setTargetAtTime(0, ctx.currentTime, GATE_RELEASE_TC);
            }
            void vad.start();
          })
          .catch((err) => console.warn("[voice] Silero VAD init failed:", err));
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
      if (gateIntervalIdRef.current !== null) {
        window.clearInterval(gateIntervalIdRef.current);
        gateIntervalIdRef.current = null;
      }
      void vadRef.current?.pause();
      vadRef.current = null;
      rnnoiseNodeRef.current = null;
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
            name: playerName || identity,
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
          audioTrack.setVolume(MIN_GAIN_FLOOR);

          remoteEntries.current.set(participant.identity, {
            participant,
            track: audioTrack,
            audio,
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

        const connectOpts: { autoSubscribe: boolean; rtcConfig?: RTCConfiguration } = {
          autoSubscribe: false,
        };
        if (IS_FIREFOX) {
          connectOpts.rtcConfig = { iceServers: resolveIceServersForFirefox() };
        }
        await room.connect(url, token, connectOpts);

        roomRef.current = room;
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
        const micTrack = localStream.current!.getAudioTracks()[0];
        if (micTrack) {
          await room.localParticipant.publishTrack(micTrack, {
            source: Track.Source.Microphone,
            name: "mic",
          });
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
  }, [socket?.id, isMicReady, playerName]);

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
        const speaking =
          localSpeakingFrames.current >= SPEAKING_HYSTERESIS_UP ||
          (wasLocalSpeaking.current && localSpeakingFrames.current > -SPEAKING_HYSTERESIS_DOWN);
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
          const targetGain = Math.max(MIN_GAIN_FLOOR, distanceFactor * userGain);
          entry.track.setVolume(Math.min(1, targetGain));

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
      setAudioInterrupted(ctxState === "interrupted" && hasPeers);
      setAudioBlocked(ctxState === "suspended" && hasPeers);
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
      localStream.current?.getAudioTracks().forEach((t) => {
        t.enabled = !next;
      });
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

  async function toggleAgc() {
    const next = !agcEnabled;
    setAgcEnabledState(next);
    const track = rawMicStream.current?.getAudioTracks()[0];
    if (track) {
      try {
        await track.applyConstraints({ autoGainControl: next });
      } catch {
        /* ignore */
      }
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

  function toggleRnnoise() {
    const next = !rnnoiseEnabledRef.current;
    setRnnoiseEnabledState(next);
    try {
      localStorage.setItem(RNNOISE_STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
    const ctx = audioCtx.current;
    const gate = noiseGateNode.current;
    const micSource = micSourceRef.current;
    if (!ctx || !gate || !micSource) return;
    micSource.disconnect();
    if (next) {
      let rnnoiseNode = rnnoiseNodeRef.current;
      if (!rnnoiseNode) {
        rnnoiseNode = new AudioWorkletNode(ctx, NoiseSuppressorWorklet_Name);
        rnnoiseNodeRef.current = rnnoiseNode;
      }
      micSource.connect(rnnoiseNode).connect(gate);
    } else {
      micSource.connect(gate);
      const rnnoiseNode = rnnoiseNodeRef.current;
      if (rnnoiseNode) rnnoiseNode.disconnect();
    }
  }

  function updateGateThreshold(value: number) {
    const next = Math.max(0, value);
    setGateThresholdState(next);
    const ctx = audioCtx.current;
    const gate = noiseGateNode.current;
    if (next === 0) {
      if (ctx && gate) gate.gain.setTargetAtTime(1, ctx.currentTime, GATE_ATTACK_TC);
    } else {
      vadRef.current?.setOptions({
        positiveSpeechThreshold: next / 100,
        negativeSpeechThreshold: Math.max(0.01, next / 100 - 0.15),
      });
    }
    try {
      localStorage.setItem(GATE_STORAGE_KEY, String(next));
    } catch {
      /* ignore */
    }
  }

  function updateRolloff(value: number) {
    const next = Math.max(0.1, value);
    setRolloffState(next);
    try {
      localStorage.setItem(ROLLOFF_STORAGE_KEY, String(next));
    } catch {
      /* ignore */
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
    rolloff,
    setRolloff: updateRolloff,
    agcEnabled,
    toggleAgc,
    echoCancelEnabled,
    toggleEchoCancel,
    rnnoiseEnabled,
    toggleRnnoise,
    headphonePrompt,
    confirmHeadphones,
    gateThreshold,
    setGateThreshold: updateGateThreshold,
    audioBlocked,
    audioInterrupted,
  };
}
