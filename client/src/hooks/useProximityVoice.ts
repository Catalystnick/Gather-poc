// Phase 2 — WebRTC P2P proximity voice
// Manages peer connections based on distance to remote players.
// Signaling is relayed through the Socket.IO server.

import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { RemotePlayer } from "../types";
import { MicVAD } from "@ricky0123/vad-web";
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
const MIC_GAIN_STORAGE_KEY = "gather_poc_mic_gain";
const ROLLOFF_STORAGE_KEY = "gather_poc_rolloff";
const DEFAULT_ROLLOFF = 1.4; // exponent applied to normalised distance (0–1)
const HPF_STORAGE_KEY = "gather_poc_hpf_freq";
const GATE_STORAGE_KEY = "gather_poc_gate_threshold";
const DEFAULT_GATE_THRESHOLD = 0; // speech probability ×100 (0–100); 0 = off (natural baseline)
const RNNOISE_STORAGE_KEY = "gather_poc_rnnoise";
const AUDIO_SETTINGS_VERSION_KEY = "gather_poc_audio_settings_version";
const AUDIO_SETTINGS_VERSION = "2026-03-standard-v1";
const GATE_ATTACK_TC = 0.003;  // seconds — time constant to open (fast, ~10ms)
const GATE_RELEASE_TC = 0.08;  // seconds — time constant to close (slow, ~250ms)
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
    // Keep capture unfiltered by default; VAD gate handles muting logic.
    noiseSuppression: false,
    // AGC: enabled on mobile so the OS normalises mic input levels — without it,
    // mobile mics send a quiet raw signal and the receiving side hears low volume.
    // Disabled on desktop where headset hardware manages gain staging.
    autoGainControl: IS_MOBILE,
  } as MediaTrackConstraints,
  video: false,
};

// Older iOS/macOS Safari ships the Web Audio API under the webkit prefix.
const AudioContextCtor: typeof AudioContext =
  window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

let audioSettingsMigrationChecked = false;

interface PeerEntry {
  connection: RTCPeerConnection;
  // Muted element — Chrome pipeline activation only.
  // Chrome requires the raw WebRTC stream to be attached to an HTMLAudioElement
  // before createMediaStreamSource() produces samples. This element is always
  // muted so it never emits sound. Firefox/Safari don't need it but it's harmless.
  // Ref: https://stackoverflow.com/questions/55703316
  audio: HTMLAudioElement;
  // Processing chain:
  //   source → gainNode
  // Playback differs by platform:
  //   mobile  → stereoMerger → gainDest → outputAudio (media pipeline/loudspeaker)
  //   desktop → AudioContext.destination (native Web Audio output path)
  // gainNode: distance attenuation + user slider (not capped at 1.0).
  gainNode: GainNode;
  stereoMerger: ChannelMergerNode | null;
  gainDest: MediaStreamAudioDestinationNode | null;
  outputAudio: HTMLAudioElement | null;
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
  const [micGain, setMicGainState] = useState(loadMicGain());
  const [rolloff, setRolloffState] = useState(loadRolloff());
  const [gateThreshold, setGateThresholdState] = useState(loadGateThreshold());
  // AGC default matches the AUDIO_CONSTRAINTS constant (on for mobile, off for desktop).
  const [agcEnabled, setAgcEnabledState] = useState<boolean>(IS_MOBILE);
  // echoCancelEnabled tracks whether AEC is currently active on the mic track.
  const [echoCancelEnabled, setEchoCancelEnabledState] = useState(true);
  // headphonePrompt: non-null while the "headphones detected" confirm banner is visible.
  // Value is the device label string shown to the user.
  const [headphonePrompt, setHeadphonePrompt] = useState<string | null>(null);
  // audioBlocked: suspended context, user tap will fix it.
  // audioInterrupted: exclusive hardware use (phone call etc), user cannot fix it —
  //   the OS will restore it when the interruption ends.
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [audioInterrupted, setAudioInterrupted] = useState(false);
  const [rnnoiseEnabled, setRnnoiseEnabledState] = useState(loadRnnoiseEnabled());

  const localStream = useRef<MediaStream | null>(null); // mic-gain output stream → sent over WebRTC
  const rawMicStream = useRef<MediaStream | null>(null); // raw getUserMedia stream → stop() on cleanup
  const audioCtx = useRef<AudioContext | null>(null);
  const micGainNode = useRef<GainNode | null>(null); // controls outgoing mic level
  const noiseGateNode = useRef<GainNode | null>(null); // noise gate before micGain
  const gateIntervalIdRef = useRef<number | null>(null); // RMS fallback interval id
  const vadRef = useRef<MicVAD | null>(null); // Silero VAD instance (replaces RMS gate when ready)
  const rnnoiseNodeRef = useRef<AudioWorkletNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
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
  const rolloffRef = useRef(rolloff);
  rolloffRef.current = rolloff;
  const gateThresholdRef = useRef(gateThreshold);
  gateThresholdRef.current = gateThreshold;
  const echoCancelEnabledRef = useRef(echoCancelEnabled);
  echoCancelEnabledRef.current = echoCancelEnabled;
  const rnnoiseEnabledRef = useRef(rnnoiseEnabled);
  rnnoiseEnabledRef.current = rnnoiseEnabled;

  // Tracks output device IDs seen on the previous devicechange (or mount).
  // Used to diff which device newly appeared or disappeared.
  const prevOutputDeviceIdsRef = useRef<Set<string>>(new Set());
  // The deviceId of the output device the user confirmed as headphones.
  // Used to auto-restore AEC when that device disconnects.
  const headphoneDeviceIdRef = useRef<string | null>(null);

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
      // Mobile uses outputAudio (HTMLMediaElement path) to stay on loudspeaker.
      // Retry any peer output element that was blocked by autoplay policy.
      peers.current.forEach((entry) => {
        if (entry.outputAudio?.paused) {
          void entry.outputAudio.play().catch(() => {});
        }
      });
    };

    const resumeOnVisibility = () => {
      // Mobile browsers suspend AudioContext when the tab goes to the
      // background. Resume as soon as the tab is visible again.
      if (!document.hidden && ctx.state === "suspended") {
        void ctx.resume().catch(() => {});
      }
    };

    // iOS Safari: "play-and-record" maps to AVAudioSessionCategoryPlayAndRecord
    // so the mic and speaker can both be active simultaneously.
    if ("audioSession" in navigator) {
      (navigator as unknown as { audioSession: { type: string } }).audioSession.type =
        "play-and-record";
    }

    if (navigator.mediaDevices) {
      const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
      const workletUrl = new URL("NoiseSuppressorWorklet.js", window.location.origin + base).href;
      // Load worklet in parallel; if it fails (COEP, module resolution, etc.) we
      // still proceed without RNnoise so the mic works.
      const workletReady = ctx.audioWorklet
        .addModule(workletUrl)
        .then(() => true)
        .catch((err) => {
          console.warn("[voice] RNnoise worklet failed to load — noise suppression disabled:", err);
          return false;
        });
      navigator.mediaDevices
        .getUserMedia(AUDIO_CONSTRAINTS)
        .then(async (rawStream) => {
          const rnnoiseAvailable = await workletReady;
          // Keep the raw hardware stream separate so we can stop the mic
          // tracks on cleanup.
          rawMicStream.current = rawStream;

          // Mic gain stage with optional VAD gating and RNnoise noise suppression.
          // Signal graph:
          //   raw mic → [rnnoiseNode?] → noiseGateNode → GainNode → MediaStreamDestination → WebRTC
          // noiseGateNode holds at 1.0 (pass-through) when threshold is 0 (disabled).
          const gateNode = ctx.createGain();
          gateNode.gain.value = 1;
          noiseGateNode.current = gateNode;
          const gainNode = ctx.createGain();
          gainNode.gain.value = loadMicGain();
          micGainNode.current = gainNode;
          const micSource = ctx.createMediaStreamSource(rawStream);
          micSourceRef.current = micSource;
          const micDest = ctx.createMediaStreamDestination();

          const useRnnoise = loadRnnoiseEnabled() && rnnoiseAvailable;
          if (useRnnoise) {
            const rnnoiseNode = new AudioWorkletNode(ctx, NoiseSuppressorWorklet_Name);
            rnnoiseNodeRef.current = rnnoiseNode;
            micSource.connect(rnnoiseNode).connect(gateNode).connect(gainNode).connect(micDest);
            console.log("[voice] RNnoise noise suppression active");
          } else {
            micSource.connect(gateNode).connect(gainNode).connect(micDest);
          }
          localStream.current = micDest.stream;

          // Android Chrome 145+ supports AudioContext.setSinkId(), which can
          // route Web Audio output to the loudspeaker instead of the earpiece.
          // getUserMedia must already be granted for enumerateDevices() to return
          // the full device list (otherwise only "default" is visible).
          // This is a best-effort attempt: many Android devices only expose one
          // "default" audiooutput so there may be nothing to switch to.
          if (IS_MOBILE && "setSinkId" in ctx) {
            try {
              const devices = await navigator.mediaDevices.enumerateDevices();
              const outputs = devices.filter((d) => d.kind === "audiooutput");
              // Prefer an explicit loudspeaker device; fall back to first output.
              const speaker =
                outputs.find((d) => /speaker/i.test(d.label) && !/ear/i.test(d.label))
                ?? outputs[0];
              if (speaker) {
                await (ctx as AudioContext & { setSinkId(id: string): Promise<void> })
                  .setSinkId(speaker.deviceId);
                console.log("[voice] AudioContext routed to:", speaker.label || speaker.deviceId);
              }
            } catch (err) {
              console.warn("[voice] AudioContext.setSinkId failed (non-fatal):", err);
            }
          }

          setIsMicReady(true);
          // ctx.resume() here is outside a user-gesture on iOS and is silently
          // ignored; the gesture handlers above are the reliable resume path.
          void ctx.resume().catch(() => {/* will resume on next gesture */});

          // Connect raw stream to speaking-detection analyser.
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          ctx.createMediaStreamSource(rawStream).connect(analyser);
          localAnalyser.current = analyser;

          // Noise gate — Silero VAD (ML-based) with RMS fallback.
          //
          // Primary: MicVAD (Silero VAD v5/legacy model via ONNX) runs its own
          //   AudioWorklet inside our AudioContext, reading from rawStream.
          //   onSpeechStart/onSpeechEnd open/close the noiseGateNode with the same
          //   GATE_ATTACK_TC / GATE_RELEASE_TC time constants.
          //
          // Fallback: if MicVAD fails to load (model fetch blocked, WASM unsupported
          //   etc.) an RMS threshold interval keeps the gate functional.
          //
          // Gate threshold 0 → gate disabled; >0 maps to positiveSpeechThreshold
          //   (value / 100).  The RMS fallback uses the value directly on 0–255 scale.

          // --- RMS fallback interval (runs until VAD replaces it) ---
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

          // --- Silero VAD (primary) ---
          // Initialised asynchronously; on success it cancels the RMS interval.
          // We pass our existing AudioContext and rawStream so the VAD worklet
          // lives in the same audio graph without a second getUserMedia call.
          // pauseStream/resumeStream are no-ops — we own the stream lifecycle.
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
            // Hold the gate open for ~300ms after speech drops — avoids clipping
            // trailing consonants and breath pauses mid-sentence.
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
          }).then((vad) => {
            vadRef.current = vad;
            // Cancel the RMS fallback — VAD takes over from here.
            if (gateIntervalIdRef.current !== null) {
              window.clearInterval(gateIntervalIdRef.current);
              gateIntervalIdRef.current = null;
            }
            // If gate is active, start closed and wait for first speech event.
            if (gateThresholdRef.current > 0 && noiseGateNode.current) {
              noiseGateNode.current.gain.setTargetAtTime(0, ctx.currentTime, GATE_RELEASE_TC);
            }
            void vad.start();
            console.log("[voice] Silero VAD gate active");
          }).catch((err) => {
            console.warn("[voice] Silero VAD init failed — RMS gate fallback active:", err);
          });

          // Attach mic tracks to peers that were created while permission was
          // pending, and renegotiate so they receive our audio.
          // socketRef.current — NOT the closure-captured `socket` — ensures we
          // always use the live socket even though this effect has [] deps.
          peers.current.forEach(({ connection }, peerId) => {
            attachLocalTracks(connection, localStream.current ?? rawStream);
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
      // Stop the raw hardware mic tracks.
      rawMicStream.current?.getTracks().forEach((track) => track.stop());
      if (gateIntervalIdRef.current !== null) {
        window.clearInterval(gateIntervalIdRef.current);
        gateIntervalIdRef.current = null;
      }
      // Pause (not destroy) the VAD — we own the stream lifecycle here.
      void vadRef.current?.pause();
      vadRef.current = null;
      rnnoiseNodeRef.current = null;
      micSourceRef.current = null;
      // Closing the AudioContext also destroys all nodes in this graph.
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

  // Headphone / audio output device detection.
  // Listens for devicechange events and diffs the output device list to detect
  // newly connected devices (likely headphones).  Prompts the user to disable
  // AEC when that happens; auto-restores AEC when the confirmed device leaves.
  // Does not run on iOS (enumerateDevices never exposes output devices there).
  useEffect(() => {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.addEventListener !== "function") return;

    let disposed = false;

    // Snapshot the baseline output devices on mount so we can diff against them.
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      if (disposed) return;
      prevOutputDeviceIdsRef.current = new Set(
        devices
          .filter((d) => d.kind === "audiooutput")
          .map((d) => d.deviceId),
      );
    }).catch(() => {});

    async function handleDeviceChange() {
      if (disposed) return;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter((d) => d.kind === "audiooutput");
        const newIds = new Set(outputs.map((d) => d.deviceId));

        // "default" and "communications" are virtual aliases — skip them to avoid
        // false-positive prompts when the OS switches the default output.
        const appeared = outputs.filter(
          (d) =>
            !prevOutputDeviceIdsRef.current.has(d.deviceId) &&
            d.deviceId !== "default" &&
            d.deviceId !== "communications",
        );
        const disappearedIds = [...prevOutputDeviceIdsRef.current].filter(
          (id) => !newIds.has(id),
        );

        prevOutputDeviceIdsRef.current = newIds;

        // If the confirmed headphone device disconnected and AEC was off, re-enable.
        const confirmedId = headphoneDeviceIdRef.current;
        if (
          confirmedId &&
          disappearedIds.includes(confirmedId) &&
          !echoCancelEnabledRef.current
        ) {
          headphoneDeviceIdRef.current = null;
          console.log("[voice] headphones disconnected — restoring AEC");
          void applyEchoCancel(true);
        }

        // New output device appeared — prompt the user.
        if (appeared.length > 0) {
          const device = appeared[0];
          headphoneDeviceIdRef.current = device.deviceId;
          setHeadphonePrompt(device.label || "New audio device");
        }
      } catch {
        // enumerateDevices can fail if permissions were revoked; ignore silently.
      }
    }

    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => {
      disposed = true;
      navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
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
          const distanceFactor = 1 - normalized ** rolloffRef.current;
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

  function enforceOpusCodec(pc: RTCPeerConnection): void {
    try {
      const caps = RTCRtpReceiver.getCapabilities?.("audio");
      if (!caps?.codecs) return;
      const opus = caps.codecs.filter((c) => c.mimeType?.toLowerCase() === "audio/opus");
      if (opus.length === 0) return;
      for (const tr of pc.getTransceivers()) {
        if ((tr as { kind?: string }).kind === "audio") tr.setCodecPreferences(opus);
      }
    } catch {
      /* setCodecPreferences not supported or failed */
    }
  }

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

    // Chrome pipeline activation workaround: WebRTC remote streams only flow
    // through createMediaStreamSource() once the stream is also attached to a
    // muted HTMLAudioElement. Actual audible playback is handled by the Web
    // Audio graph (gainNode → ctx.destination) below.
    // iOS loudspeaker routing is handled separately via the iosRoutingAudio
    // element created in the mic-acquisition useEffect (see above).
    // IMPORTANT: Chrome can ignore muted on dynamically created elements, causing
    // double playback (activation element + gain path) = echo. Use volume=0 too.
    const audio = new Audio();
    audio.muted = true;
    audio.volume = 0;
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");
    audio.setAttribute("muted", "");

    // GainNode controls distance-based attenuation and the user's slider.
    // Mobile and desktop use different playback targets:
    // - mobile: HTMLMediaElement output path for reliable loudspeaker routing
    // - desktop: direct Web Audio output for a cleaner, lower-complexity path
    const gainNode = ctx.createGain();
    gainNode.gain.value = MIN_GAIN_FLOOR;
    const stereoMerger = ctx.createChannelMerger(2);
    let gainDest: MediaStreamAudioDestinationNode | null = null;
    let outputAudio: HTMLAudioElement | null = null;
    // Duplicate mono voice to both channels before final playback/output.
    // This avoids browser-specific mono panning quirks (left-only output).
    gainNode.connect(stereoMerger, 0, 0);
    gainNode.connect(stereoMerger, 0, 1);
    if (IS_MOBILE) {
      gainDest = ctx.createMediaStreamDestination();
      stereoMerger.connect(gainDest);

      outputAudio = new Audio();
      outputAudio.srcObject = gainDest.stream;
      outputAudio.setAttribute("playsinline", "true");
      outputAudio.volume = 1;
    } else {
      stereoMerger.connect(ctx.destination);
    }

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

      // Step 1 — Chrome pipeline activation (muted, no sound).
      entry.audio.volume = 0;
      entry.audio.srcObject = stream;
      void entry.audio.play().catch(() => {
        console.warn(`[voice] chrome-activation audio.play() failed for ${peerId}`);
      });

      if (!entry.analyserSource) {
        // Step 2 — Web Audio graph:
        //   source → gainNode   (volume-controlled playback)
        //   source → analyser   (speaking detection, no output)
        const source = ctx.createMediaStreamSource(stream);
        source.connect(entry.gainNode);
        source.connect(entry.analyser);
        entry.analyserSource = source;
      }

      // Step 3 (mobile only) — play output element for loudspeaker route.
      if (entry.outputAudio) {
        void entry.outputAudio.play().catch(() => {
          console.warn(`[voice] outputAudio.play() blocked for ${peerId} — will retry on gesture`);
        });
      }
    };

    peers.current.set(peerId, {
      connection: pc,
      audio,
      gainNode,
      stereoMerger,
      gainDest,
      outputAudio,
      analyser,
      analyserSource: null,
      pendingCandidates: [],
    });

    if (initiator) {
      void (async () => {
        try {
          enforceOpusCodec(pc);
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
    entry.stereoMerger?.disconnect();
    entry.gainDest?.disconnect();
    entry.analyser.disconnect();
    entry.audio.pause();
    entry.audio.srcObject = null;
    entry.outputAudio?.pause();
    if (entry.outputAudio) {
      entry.outputAudio.srcObject = null;
    }

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
      enforceOpusCodec(pc);
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
      enforceOpusCodec(entry.connection);
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
    const next = Math.max(0, value);
    setRemoteGain(next);
    try { localStorage.setItem(GAIN_STORAGE_KEY, String(next)); } catch { /* storage unavailable */ }
  }

  async function toggleAgc() {
    const next = !agcEnabled;
    setAgcEnabledState(next);
    const track = rawMicStream.current?.getAudioTracks()[0];
    if (track) {
      try {
        await track.applyConstraints({ autoGainControl: next });
        console.log(`[voice] AGC ${next ? "enabled" : "disabled"}`);
      } catch (err) {
        console.warn("[voice] applyConstraints(autoGainControl) failed:", err);
      }
    }
  }

  async function applyEchoCancel(enable: boolean) {
    setEchoCancelEnabledState(enable);
    const track = rawMicStream.current?.getAudioTracks()[0];
    if (track) {
      try {
        await track.applyConstraints({ echoCancellation: enable });
        console.log(`[voice] AEC ${enable ? "enabled" : "disabled"}`);
      } catch (err) {
        console.warn("[voice] applyConstraints(echoCancellation) failed:", err);
      }
    }
  }

  function confirmHeadphones(accept: boolean) {
    setHeadphonePrompt(null);
    if (accept) {
      void applyEchoCancel(false);
    } else {
      // User declined — forget this device so it doesn't trigger again on reconnect.
      headphoneDeviceIdRef.current = null;
    }
  }

  function toggleEchoCancel() {
    void applyEchoCancel(!echoCancelEnabledRef.current);
  }

  function toggleRnnoise() {
    const next = !rnnoiseEnabledRef.current;
    setRnnoiseEnabledState(next);
    try {
      localStorage.setItem(RNNOISE_STORAGE_KEY, next ? "1" : "0");
    } catch { /* storage unavailable */ }

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
      console.log("[voice] RNnoise noise suppression enabled");
    } else {
      micSource.connect(gate);
      const rnnoiseNode = rnnoiseNodeRef.current;
      if (rnnoiseNode) rnnoiseNode.disconnect();
      console.log("[voice] RNnoise noise suppression disabled");
    }
  }

  function updateGateThreshold(value: number) {
    const next = Math.max(0, value);
    setGateThresholdState(next);
    const ctx = audioCtx.current;
    const gate = noiseGateNode.current;
    if (next === 0) {
      // Gate disabled — open immediately so mic is never silenced.
      if (ctx && gate) gate.gain.setTargetAtTime(1, ctx.currentTime, GATE_ATTACK_TC);
    } else {
      // Update VAD thresholds at runtime without reinitialising the model.
      const posThresh = next / 100;
      vadRef.current?.setOptions({
        positiveSpeechThreshold: posThresh,
        negativeSpeechThreshold: Math.max(0.01, posThresh - 0.15),
      });
    }
    try { localStorage.setItem(GATE_STORAGE_KEY, String(next)); } catch { /* storage unavailable */ }
  }

  function updateRolloff(value: number) {
    const next = Math.max(0.1, value);
    setRolloffState(next);
    try { localStorage.setItem(ROLLOFF_STORAGE_KEY, String(next)); } catch { /* storage unavailable */ }
  }

  function updateMicGain(value: number) {
    const next = Math.max(0, value);
    setMicGainState(next);
    if (micGainNode.current && audioCtx.current) {
      micGainNode.current.gain.setTargetAtTime(next, audioCtx.current.currentTime, 0.02);
    }
    try { localStorage.setItem(MIC_GAIN_STORAGE_KEY, String(next)); } catch { /* storage unavailable */ }
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
  ensureAudioSettingsMigration();
  try {
    const raw = localStorage.getItem(GAIN_STORAGE_KEY);
    // Mobile speakers need more drive than desktop headphones/monitors.
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
    // Mobile mics are typically quieter without AGC, so we default higher.
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
    if (!raw) return true; // default on for noise suppression
    return raw === "1" || raw.toLowerCase() === "true";
  } catch {
    return true;
  }
}

function ensureAudioSettingsMigration() {
  if (audioSettingsMigrationChecked) return;
  audioSettingsMigrationChecked = true;
  try {
    if (localStorage.getItem(AUDIO_SETTINGS_VERSION_KEY) === AUDIO_SETTINGS_VERSION) {
      return;
    }
    // One-time reset so older persisted tuning values don't override
    // the new "standard quality" defaults for existing users.
    localStorage.removeItem(GAIN_STORAGE_KEY);
    localStorage.removeItem(MIC_GAIN_STORAGE_KEY);
    localStorage.removeItem(ROLLOFF_STORAGE_KEY);
    localStorage.removeItem(HPF_STORAGE_KEY);
    localStorage.removeItem(GATE_STORAGE_KEY);
    localStorage.removeItem(RNNOISE_STORAGE_KEY);
    localStorage.setItem(AUDIO_SETTINGS_VERSION_KEY, AUDIO_SETTINGS_VERSION);
  } catch {
    // localStorage may be unavailable (privacy mode, SSR, etc.)
  }
}
