// Top-down orthographic camera that:
// - Smoothly follows the local player
// - Lets the user drag to pan and explore the map
// - Snaps back to following when the player moves with WASD

import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useKeyboardControls } from '@react-three/drei'
import { MathUtils, OrthographicCamera } from 'three'
import { useControls } from 'leva'

const ZOOM = 60   // world units visible: canvas_px / zoom
const LERP = 0.1  // camera follow smoothness (0 = no follow, 1 = instant)

interface Props {
  targetRef: React.MutableRefObject<{ x: number; y: number; z: number }>
}

export default function CameraRig({ targetRef }: Props) {
  const { camera, gl } = useThree()
  const offset = useRef({ x: 0, z: 0 })
  const drag = useRef({ active: false, lastX: 0, lastY: 0 })
  const hasPanned = useRef(false)
  const [, getKeys] = useKeyboardControls()
  const prevZoom = useRef(ZOOM)

  const { zoom } = useControls('Camera', {
    zoom: { value: ZOOM, min: 20, max: 150, step: 5, label: 'Zoom' },
  })

  // One-time orthographic top-down setup
  // camera.up = (0, 0, -1) → world -Z is screen-up (north)
  // screen right = world +X, screen down = world +Z
  useEffect(() => {
    camera.up.set(0, 0, -1)
    camera.position.set(0, 20, 0)
    camera.lookAt(0, 0, 0)
    if (camera instanceof OrthographicCamera) {
      camera.zoom = ZOOM
      camera.updateProjectionMatrix()
    }
  }, [camera])

  // Pointer events — drag to pan
  // Derivation: for world point to follow cursor exactly,
  //   Δcamera = -Δscreen / zoom
  useEffect(() => {
    const el = gl.domElement

    const onDown = (e: PointerEvent) => {
      hasPanned.current = true
      drag.current = { active: true, lastX: e.clientX, lastY: e.clientY }
    }

    const onMove = (e: PointerEvent) => {
      if (!drag.current.active) return
      const zoom = camera instanceof OrthographicCamera ? camera.zoom : ZOOM
      const scale = 1 / zoom
      offset.current.x -= (e.clientX - drag.current.lastX) * scale
      offset.current.z -= (e.clientY - drag.current.lastY) * scale
      drag.current.lastX = e.clientX
      drag.current.lastY = e.clientY
    }

    const onUp = () => { drag.current.active = false }

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)

    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [camera, gl])

  useFrame(() => {
    const { forward, backward, left, right } = getKeys()
    const isMoving = forward || backward || left || right

    // Player moved with WASD — clear pan and lerp offset back to zero
    if (isMoving && hasPanned.current) {
      hasPanned.current = false
    }

    if (!hasPanned.current) {
      offset.current.x = MathUtils.lerp(offset.current.x, 0, LERP)
      offset.current.z = MathUtils.lerp(offset.current.z, 0, LERP)
    }

    const { x, z } = targetRef.current
    const tx = x + offset.current.x
    const tz = z + offset.current.z

    camera.position.x = MathUtils.lerp(camera.position.x, tx, LERP)
    camera.position.z = MathUtils.lerp(camera.position.z, tz, LERP)

    // Keep looking straight down regardless of position
    camera.lookAt(camera.position.x, 0, camera.position.z)

    // Apply zoom when changed
    if (camera instanceof OrthographicCamera && zoom !== prevZoom.current) {
      camera.zoom = zoom
      camera.updateProjectionMatrix()
      prevZoom.current = zoom
    }
  })

  return null
}
