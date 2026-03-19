// Phase 2 — WebRTC P2P proximity voice
// Manages peer connections based on distance to remote players.
// Signaling is relayed through the Socket.IO server.

import { useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import type { RemotePlayer } from './useSocket'

const VOICE_RANGE = 8
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]

interface PeerEntry {
  connection: RTCPeerConnection
  gainNode: GainNode
}

export function useProximityVoice(
  socket: Socket | null,
  localPosition: { x: number; y: number; z: number },
  remotePlayers: Map<string, RemotePlayer>
) {
  const [muted, setMuted] = useState(false)
  const localStream = useRef<MediaStream | null>(null)
  const audioCtx = useRef<AudioContext | null>(null)
  const peers = useRef<Map<string, PeerEntry>>(new Map())

  // Acquire mic on mount
  useEffect(() => {
    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(stream => { localStream.current = stream })
      .catch(err => console.warn('[voice] mic denied:', err))

    audioCtx.current = new AudioContext()

    return () => {
      peers.current.forEach(({ connection }) => connection.close())
      peers.current.clear()
      localStream.current?.getTracks().forEach(t => t.stop())
      audioCtx.current?.close()
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

  // Proximity check — throttled to ~10Hz via setInterval
  useEffect(() => {
    if (!socket) return

    const interval = setInterval(() => {
      remotePlayers.forEach((remote, id) => {
        const dist = distance(localPosition, remote.position)
        const connected = peers.current.has(id)

        if (dist < VOICE_RANGE && !connected) {
          initiatePeer(id, socket)
        } else if (dist >= VOICE_RANGE && connected) {
          closePeer(id)
          socket.emit('rtc:hangup', { to: id })
        } else if (connected) {
          const gain = peers.current.get(id)?.gainNode
          if (gain) gain.gain.value = 1 - dist / VOICE_RANGE
        }
      })
    }, 100)

    return () => clearInterval(interval)
  }, [socket, localPosition, remotePlayers])

  function getOrCreatePeer(peerId: string, socket: Socket, initiator: boolean): RTCPeerConnection {
    if (peers.current.has(peerId)) return peers.current.get(peerId)!.connection

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    const gainNode = audioCtx.current!.createGain()
    gainNode.gain.value = 1
    gainNode.connect(audioCtx.current!.destination)

    localStream.current?.getTracks().forEach(t => pc.addTrack(t, localStream.current!))

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('rtc:ice-candidate', { to: peerId, candidate })
    }

    pc.ontrack = ({ streams }) => {
      const source = audioCtx.current!.createMediaStreamSource(streams[0])
      source.connect(gainNode)
    }

    peers.current.set(peerId, { connection: pc, gainNode })

    if (!initiator) return pc

    pc.createOffer().then(offer => {
      pc.setLocalDescription(offer)
      socket.emit('rtc:offer', { to: peerId, offer })
    })

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
    localStream.current?.getAudioTracks().forEach(t => {
      t.enabled = muted // flip: if currently muted, re-enable
    })
    setMuted(m => !m)
  }

  return { muted, toggleMute }
}

function distance(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}
