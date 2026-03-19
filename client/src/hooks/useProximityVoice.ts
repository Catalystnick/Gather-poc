// Phase 2 — WebRTC P2P proximity voice
// Manages peer connections based on distance to remote players.
// Signaling is relayed through the Socket.IO server.

import { useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import type { RemotePlayer } from './useSocket'

const VOICE_RANGE = 8
const SPEAKING_THRESHOLD = 20
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]

interface PeerEntry {
  connection: RTCPeerConnection
  gainNode: GainNode
  analyser: AnalyserNode
}

export function useProximityVoice(
  socket: Socket | null,
  localPositionRef: React.MutableRefObject<{ x: number; y: number; z: number }>,
  remotePlayers: Map<string, RemotePlayer>
) {
  const [muted, setMuted] = useState(false)
  const [isLocalSpeaking, setIsLocalSpeaking] = useState(false)
  const [speakingPeers, setSpeakingPeers] = useState<Set<string>>(new Set())
  const [connectedPeers, setConnectedPeers] = useState<Set<string>>(new Set())

  const localStream = useRef<MediaStream | null>(null)
  const audioCtx = useRef<AudioContext | null>(null)
  const localAnalyser = useRef<AnalyserNode | null>(null)
  const peers = useRef<Map<string, PeerEntry>>(new Map())

  const remotePlayersRef = useRef(remotePlayers)
  remotePlayersRef.current = remotePlayers

  const wasLocalSpeaking = useRef(false)
  const wasSpeakingPeers = useRef(new Set<string>())

  // Acquire mic and set up local speaking analyser
  useEffect(() => {
    const ctx = new AudioContext()
    audioCtx.current = ctx

    // Browsers suspend AudioContext until a user gesture.
    // Resume it as soon as mic permission is granted (which itself requires a gesture).
    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(stream => {
        localStream.current = stream
        ctx.resume()

        // Analyser on local mic so we can detect our own speaking
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        ctx.createMediaStreamSource(stream).connect(analyser)
        localAnalyser.current = analyser
      })
      .catch(err => console.warn('[voice] mic denied:', err))

    // Fallback: also resume on any user interaction in case mic was
    // pre-granted and the AudioContext was created before a gesture
    const resume = () => { ctx.resume() }
    window.addEventListener('pointerdown', resume, { once: true })

    return () => {
      window.removeEventListener('pointerdown', resume)
      peers.current.forEach(({ connection }) => connection.close())
      peers.current.clear()
      localStream.current?.getTracks().forEach(t => t.stop())
      ctx.close()
    }
  }, [])

  // Handle incoming signaling events
  useEffect(() => {
    if (!socket) return

    socket.on('rtc:offer', async ({ from, offer }: { from: string; offer: RTCSessionDescriptionInit }) => {
      const pc = getOrCreatePeer(from, socket, false)
      await pc.setRemoteDescription(offer)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      socket.emit('rtc:answer', { to: from, answer })
    })

    socket.on('rtc:answer', async ({ from, answer }: { from: string; answer: RTCSessionDescriptionInit }) => {
      await peers.current.get(from)?.connection.setRemoteDescription(answer)
    })

    socket.on('rtc:ice-candidate', async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
      await peers.current.get(from)?.connection.addIceCandidate(candidate)
    })

    socket.on('rtc:hangup', ({ from }: { from: string }) => closePeer(from))

    return () => {
      socket.off('rtc:offer')
      socket.off('rtc:answer')
      socket.off('rtc:ice-candidate')
      socket.off('rtc:hangup')
    }
  }, [socket])

  // Proximity + speaking detection — restarts only when socket changes
  useEffect(() => {
    if (!socket) return

    const dataArray = new Uint8Array(128)

    const interval = setInterval(() => {
      const local = localPositionRef.current
      const remote = remotePlayersRef.current
      const nextSpeaking = new Set<string>()

      // Detect local speaking via local mic analyser
      if (localAnalyser.current) {
        localAnalyser.current.getByteFrequencyData(dataArray)
        const speaking = rmsOf(dataArray) > SPEAKING_THRESHOLD
        if (speaking !== wasLocalSpeaking.current) {
          console.log(`[voice] you ${speaking ? 'started' : 'stopped'} speaking`)
          wasLocalSpeaking.current = speaking
        }
        setIsLocalSpeaking(speaking)
      }

      // Proximity + remote speaking detection
      remote.forEach((player, id) => {
        const dist = distance(local, player.position)
        const connected = peers.current.has(id)

        if (dist < VOICE_RANGE && !connected) {
          initiatePeer(id, socket)
        } else if (dist >= VOICE_RANGE && connected) {
          closePeer(id)
          socket.emit('rtc:hangup', { to: id })
        } else if (connected) {
          const entry = peers.current.get(id)!
          entry.gainNode.gain.value = 1 - dist / VOICE_RANGE

          // Detect remote peer speaking via their incoming stream analyser
          entry.analyser.getByteFrequencyData(dataArray)
          const remoteSpeaking = rmsOf(dataArray) > SPEAKING_THRESHOLD
          if (remoteSpeaking) nextSpeaking.add(id)

          const name = remote.get(id)?.name ?? id
          const wasSpeaking = wasSpeakingPeers.current.has(id)
          if (remoteSpeaking && !wasSpeaking) console.log(`[voice] ${name} started speaking`)
          if (!remoteSpeaking && wasSpeaking) console.log(`[voice] ${name} stopped speaking`)
        }
      })

      wasSpeakingPeers.current = nextSpeaking
      setSpeakingPeers(nextSpeaking)
      setConnectedPeers(new Set(peers.current.keys()))
    }, 100)

    return () => clearInterval(interval)
  }, [socket])

  function getOrCreatePeer(peerId: string, socket: Socket, initiator: boolean): RTCPeerConnection {
    if (peers.current.has(peerId)) return peers.current.get(peerId)!.connection

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    const ctx = audioCtx.current!

    const gainNode = ctx.createGain()
    gainNode.gain.value = 1
    gainNode.connect(ctx.destination)

    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256

    localStream.current?.getTracks().forEach(t => pc.addTrack(t, localStream.current!))

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('rtc:ice-candidate', { to: peerId, candidate })
    }

    pc.ontrack = ({ streams }) => {
      const source = ctx.createMediaStreamSource(streams[0])
      source.connect(analyser)
      analyser.connect(gainNode)
    }

    peers.current.set(peerId, { connection: pc, gainNode, analyser })

    if (initiator) {
      pc.createOffer().then(offer => {
        pc.setLocalDescription(offer)
        socket.emit('rtc:offer', { to: peerId, offer })
      })
    }

    return pc
  }

  function initiatePeer(peerId: string, socket: Socket) {
    getOrCreatePeer(peerId, socket, true)
  }

  function closePeer(peerId: string) {
    const entry = peers.current.get(peerId)
    if (entry) {
      entry.connection.close()
      peers.current.delete(peerId)
    }
  }

  function toggleMute() {
    localStream.current?.getAudioTracks().forEach(t => { t.enabled = muted })
    setMuted(m => !m)
  }

  return { muted, toggleMute, isLocalSpeaking, speakingPeers, connectedPeers }
}

function rmsOf(data: Uint8Array): number {
  return Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length)
}

function distance(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}
