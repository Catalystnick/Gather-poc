const LAST_NOTIFICATION_BY_KEY = new Map<string, number>()
const DEFAULT_COOLDOWN_MS = 3000
let gesturePermissionHookInstalled = false
let serviceWorkerRegistrationPromise: Promise<ServiceWorkerRegistration | null> | null = null
let _audioCtx: AudioContext | null = null
let _tagAudioEl: HTMLAudioElement | null = null
let _teleportAudioEl: HTMLAudioElement | null = null
const TAG_SOUND_PATH = 'ping%20audio/tag%20ping.mp3'
const TELEPORT_SOUND_PATH = 'ping%20audio/teleport%20ping.mp3'
const SOUND_DEBUG = import.meta.env.DEV

function logSound(message: string, payload?: unknown) {
  if (!SOUND_DEBUG) return
  if (payload === undefined) {
    console.log(`[notify][sound] ${message}`)
    return
  }
  console.log(`[notify][sound] ${message}`, payload)
}

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') {
    logSound('AudioContext unavailable: no window')
    return null
  }
  if (!('AudioContext' in window)) {
    logSound('AudioContext unavailable: not supported by browser')
    return null
  }
  if (!_audioCtx) {
    _audioCtx = new AudioContext()
    logSound('AudioContext created', { state: _audioCtx.state })
  }
  return _audioCtx
}

function unlockAudioContext() {
  const ctx = getAudioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') {
    logSound('AudioContext resume requested from gesture')
    void ctx.resume()
      .then(() => logSound('AudioContext resumed', { state: ctx.state }))
      .catch((error) => logSound('AudioContext resume failed', error))
    return
  }
  logSound('AudioContext already unlocked', { state: ctx.state })
}

function getTagSoundUrl() {
  const base = import.meta.env.BASE_URL ?? '/'
  const normalizedBase = base.endsWith('/') ? base : `${base}/`
  return `${normalizedBase}${TAG_SOUND_PATH}`
}

function getTeleportSoundUrl() {
  const base = import.meta.env.BASE_URL ?? '/'
  const normalizedBase = base.endsWith('/') ? base : `${base}/`
  return `${normalizedBase}${TELEPORT_SOUND_PATH}`
}

function getTagAudioElement(): HTMLAudioElement | null {
  if (typeof window === 'undefined') {
    logSound('Cannot create audio element: no window')
    return null
  }
  if (_tagAudioEl) return _tagAudioEl

  const audio = new Audio(getTagSoundUrl())
  audio.preload = 'auto'
  audio.addEventListener('canplay', () => {
    logSound('Audio canplay', {
      readyState: audio.readyState,
      networkState: audio.networkState,
      src: audio.currentSrc || audio.src,
    })
  })
  audio.addEventListener('error', () => {
    const mediaError = audio.error
    logSound('Audio element error', {
      code: mediaError?.code,
      message: mediaError?.message,
      src: audio.currentSrc || audio.src,
      readyState: audio.readyState,
      networkState: audio.networkState,
    })
  })
  audio.addEventListener('stalled', () => {
    logSound('Audio stalled', {
      src: audio.currentSrc || audio.src,
      readyState: audio.readyState,
      networkState: audio.networkState,
    })
  })
  logSound('Audio element created', {
    src: audio.currentSrc || audio.src,
    readyState: audio.readyState,
    networkState: audio.networkState,
  })
  _tagAudioEl = audio
  return audio
}

function getTeleportAudioElement(): HTMLAudioElement | null {
  if (typeof window === 'undefined') {
    logSound('Cannot create teleport audio element: no window')
    return null
  }
  if (_teleportAudioEl) return _teleportAudioEl

  const audio = new Audio(getTeleportSoundUrl())
  audio.preload = 'auto'
  audio.addEventListener('canplay', () => {
    logSound('Teleport audio canplay', {
      readyState: audio.readyState,
      networkState: audio.networkState,
      src: audio.currentSrc || audio.src,
    })
  })
  audio.addEventListener('error', () => {
    const mediaError = audio.error
    logSound('Teleport audio element error', {
      code: mediaError?.code,
      message: mediaError?.message,
      src: audio.currentSrc || audio.src,
      readyState: audio.readyState,
      networkState: audio.networkState,
    })
  })
  audio.addEventListener('stalled', () => {
    logSound('Teleport audio stalled', {
      src: audio.currentSrc || audio.src,
      readyState: audio.readyState,
      networkState: audio.networkState,
    })
  })
  logSound('Teleport audio element created', {
    src: audio.currentSrc || audio.src,
    readyState: audio.readyState,
    networkState: audio.networkState,
  })
  _teleportAudioEl = audio
  return audio
}

function primeTagAudioElement() {
  const audio = getTagAudioElement()
  if (!audio) return
  try {
    logSound('Priming audio element via load()', {
      src: audio.currentSrc || audio.src,
      readyState: audio.readyState,
      networkState: audio.networkState,
    })
    audio.load()
  } catch (error) {
    logSound('Audio preload failed', error)
    // Ignore preload failures and fall back to synth sound at playback time.
  }
}

function primeTeleportAudioElement() {
  const audio = getTeleportAudioElement()
  if (!audio) return
  try {
    logSound('Priming teleport audio element via load()', {
      src: audio.currentSrc || audio.src,
      readyState: audio.readyState,
      networkState: audio.networkState,
    })
    audio.load()
  } catch (error) {
    logSound('Teleport audio preload failed', error)
    // Ignore preload failures and fall back to synth sound at playback time.
  }
}

function playTagSoundFallback() {
  logSound('Using fallback oscillator sound')
  const ctx = getAudioContext()
  if (!ctx) {
    logSound('Fallback aborted: no AudioContext')
    return
  }
  if (ctx.state === 'closed') {
    logSound('Fallback aborted: AudioContext is closed')
    return
  }
  if (ctx.state === 'suspended') {
    logSound('Fallback resume requested before oscillator playback')
    void ctx.resume()
      .then(() => logSound('Fallback AudioContext resumed', { state: ctx.state }))
      .catch((error) => logSound('Fallback AudioContext resume failed', error))
  }

  const now = ctx.currentTime

  // First tone: lower note
  const osc1 = ctx.createOscillator()
  const gain1 = ctx.createGain()
  osc1.type = 'sine'
  osc1.frequency.value = 660
  osc1.connect(gain1)
  gain1.connect(ctx.destination)
  gain1.gain.setValueAtTime(0.18, now)
  gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.15)
  osc1.start(now)
  osc1.stop(now + 0.15)

  // Second tone: higher note, slight overlap
  const osc2 = ctx.createOscillator()
  const gain2 = ctx.createGain()
  osc2.type = 'sine'
  osc2.frequency.value = 880
  osc2.connect(gain2)
  gain2.connect(ctx.destination)
  gain2.gain.setValueAtTime(0.22, now + 0.1)
  gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.4)
  osc2.start(now + 0.1)
  osc2.stop(now + 0.4)
}

function playTeleportSoundFallback() {
  logSound('Using teleport fallback oscillator sound')
  const ctx = getAudioContext()
  if (!ctx) {
    logSound('Teleport fallback aborted: no AudioContext')
    return
  }
  if (ctx.state === 'closed') {
    logSound('Teleport fallback aborted: AudioContext is closed')
    return
  }
  if (ctx.state === 'suspended') {
    logSound('Teleport fallback resume requested before oscillator playback')
    void ctx.resume()
      .then(() => logSound('Teleport fallback AudioContext resumed', { state: ctx.state }))
      .catch((error) => logSound('Teleport fallback AudioContext resume failed', error))
  }

  const oscillator = ctx.createOscillator()
  const gain = ctx.createGain()
  oscillator.type = 'sine'
  oscillator.frequency.setValueAtTime(980, ctx.currentTime)
  oscillator.frequency.exponentialRampToValueAtTime(740, ctx.currentTime + 0.12)
  gain.gain.setValueAtTime(0.0001, ctx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16)
  oscillator.connect(gain)
  gain.connect(ctx.destination)
  oscillator.start()
  oscillator.stop(ctx.currentTime + 0.17)
}

let _faviconLink: HTMLLinkElement | null = null
let _badgeFaviconUrl: string | null = null
const TAB_BADGE_PREFIX = '• '

function getFaviconLink(): HTMLLinkElement {
  if (_faviconLink) return _faviconLink
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  _faviconLink = link
  return link
}

function getBadgeFaviconUrl(): string {
  if (_badgeFaviconUrl) return _badgeFaviconUrl
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 32
  const ctx = canvas.getContext('2d')!
  ctx.beginPath()
  ctx.arc(16, 16, 13, 0, Math.PI * 2)
  ctx.fillStyle = '#f97316'
  ctx.fill()
  _badgeFaviconUrl = canvas.toDataURL()
  return _badgeFaviconUrl
}

export function setTabBadge(active: boolean) {
  if (typeof document === 'undefined') return
  getFaviconLink().href = active ? getBadgeFaviconUrl() : ''
  if (active) {
    if (!document.title.startsWith(TAB_BADGE_PREFIX)) {
      document.title = TAB_BADGE_PREFIX + document.title
    }
  } else {
    if (document.title.startsWith(TAB_BADGE_PREFIX)) {
      document.title = document.title.slice(TAB_BADGE_PREFIX.length)
    }
  }
}

export function playTagSound() {
  logSound('playTagSound invoked', {
    visibility: typeof document === 'undefined' ? 'unknown' : document.visibilityState,
    userActivation:
      typeof navigator !== 'undefined' && navigator.userActivation
        ? {
            hasBeenActive: navigator.userActivation.hasBeenActive,
            isActive: navigator.userActivation.isActive,
          }
        : null,
  })
  const audio = getTagAudioElement()
  if (!audio) {
    logSound('No audio element available, using fallback sound')
    playTagSoundFallback()
    return
  }

  try {
    audio.currentTime = 0
    const playPromise = audio.play()
    logSound('audio.play() called', {
      src: audio.currentSrc || audio.src,
      paused: audio.paused,
      muted: audio.muted,
      volume: audio.volume,
      readyState: audio.readyState,
      networkState: audio.networkState,
      currentTime: audio.currentTime,
    })
    void playPromise
      .then(() => {
        logSound('audio.play() resolved', {
          src: audio.currentSrc || audio.src,
          paused: audio.paused,
          currentTime: audio.currentTime,
        })
      })
      .catch((error) => {
        logSound('audio.play() rejected, falling back', error)
        playTagSoundFallback()
      })
  } catch (error) {
    logSound('audio.play() threw synchronously, falling back', error)
    playTagSoundFallback()
  }
}

export function playTeleportSound() {
  logSound('playTeleportSound invoked', {
    visibility: typeof document === 'undefined' ? 'unknown' : document.visibilityState,
    userActivation:
      typeof navigator !== 'undefined' && navigator.userActivation
        ? {
            hasBeenActive: navigator.userActivation.hasBeenActive,
            isActive: navigator.userActivation.isActive,
          }
        : null,
  })
  const audio = getTeleportAudioElement()
  if (!audio) {
    logSound('No teleport audio element available, using fallback sound')
    playTeleportSoundFallback()
    return
  }

  try {
    audio.currentTime = 0
    const playPromise = audio.play()
    logSound('teleport audio.play() called', {
      src: audio.currentSrc || audio.src,
      paused: audio.paused,
      muted: audio.muted,
      volume: audio.volume,
      readyState: audio.readyState,
      networkState: audio.networkState,
      currentTime: audio.currentTime,
    })
    void playPromise
      .then(() => {
        logSound('teleport audio.play() resolved', {
          src: audio.currentSrc || audio.src,
          paused: audio.paused,
          currentTime: audio.currentTime,
        })
      })
      .catch((error) => {
        logSound('teleport audio.play() rejected, falling back', error)
        playTeleportSoundFallback()
      })
  } catch (error) {
    logSound('teleport audio.play() threw synchronously, falling back', error)
    playTeleportSoundFallback()
  }
}

function isNotificationSupported() {
  if (typeof window === 'undefined') return false
  if (!('Notification' in window)) return false
  // Browser notifications require a secure context (localhost is treated as secure).
  return window.isSecureContext || window.location.hostname === 'localhost'
}

function isServiceWorkerNotificationSupported() {
  if (typeof window === 'undefined') return false
  return 'serviceWorker' in navigator
}

async function registerNotificationServiceWorker() {
  if (!isServiceWorkerNotificationSupported()) return null
  if (serviceWorkerRegistrationPromise) return serviceWorkerRegistrationPromise

  serviceWorkerRegistrationPromise = navigator.serviceWorker
    .register('/notification-sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then((registration) => {
      console.log('[notify] service worker active for notifications')
      return registration
    })
    .catch((error) => {
      console.warn('[notify] failed to register notification service worker:', error)
      serviceWorkerRegistrationPromise = null
      return null
    })

  return serviceWorkerRegistrationPromise
}

export function getNotificationDebugState() {
  if (typeof window === 'undefined') {
    return {
      supported: false,
      secureContext: false,
      permission: 'unavailable',
      visibility: 'unknown',
    } as const
  }

  const supported = 'Notification' in window
  const permission = supported ? Notification.permission : 'unavailable'
  return {
    supported,
    secureContext: window.isSecureContext || window.location.hostname === 'localhost',
    permission,
    visibility: typeof document === 'undefined' ? 'unknown' : document.visibilityState,
    serviceWorkerSupported: 'serviceWorker' in navigator,
  } as const
}

function shouldNotifyByKey(
  key: string,
  options?: { cooldownMs?: number; requireHidden?: boolean },
) {
  const cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS
  const requireHidden = options?.requireHidden ?? true
  if (typeof document === 'undefined') return false
  if (requireHidden && document.visibilityState === 'visible') return false
  if (!isNotificationSupported()) return false
  if (Notification.permission !== 'granted') return false

  const now = Date.now()
  const lastNotifiedAt = LAST_NOTIFICATION_BY_KEY.get(key)
  if (lastNotifiedAt !== undefined && now - lastNotifiedAt < cooldownMs) return false

  LAST_NOTIFICATION_BY_KEY.set(key, now)
  return true
}

export function shouldNotifyHiddenTab(key: string, cooldownMs = DEFAULT_COOLDOWN_MS) {
  return shouldNotifyByKey(key, { cooldownMs, requireHidden: true })
}

export function shouldNotifyAnyVisibility(key: string, cooldownMs = DEFAULT_COOLDOWN_MS) {
  return shouldNotifyByKey(key, { cooldownMs, requireHidden: false })
}

export async function showBrowserNotification(title: string, body: string) {
  if (!isNotificationSupported() || Notification.permission !== 'granted') return false

  const normalizedBody = body.trim().slice(0, 500)
  const options: NotificationOptions = {
    body: normalizedBody,
    tag: `gather-${Date.now()}`,
  }

  const registration = await registerNotificationServiceWorker()
  if (registration && typeof registration.showNotification === 'function') {
    try {
      await registration.showNotification(title, options)
      console.log('[notify] dispatched via service worker', { title, body: normalizedBody })
      return true
    } catch (error) {
      console.warn('[notify] service worker showNotification failed, falling back to Notification API:', error)
    }
  }

  try {
    const notification = new Notification(title, options)
    notification.onshow = () => {
      console.log('[notify] Notification.onshow fired', { title })
    }
    notification.onerror = (event) => {
      console.warn('[notify] Notification.onerror fired', event)
    }
    notification.onclick = () => {
      window.focus()
      notification.close()
    }
    console.log('[notify] dispatched via Notification API', { title, body: normalizedBody })
    return true
  } catch (error) {
    console.warn('[notify] failed to dispatch Notification:', error)
    return false
  }
}

export function maybeRequestNotificationPermission() {
  logSound('maybeRequestNotificationPermission called', {
    notificationSupported: isNotificationSupported(),
    permission: typeof Notification === 'undefined' ? 'unavailable' : Notification.permission,
  })
  if (!isNotificationSupported()) return
  if (Notification.permission === 'default') {
    logSound('Requesting notification permission')
    void Notification.requestPermission()
      .then((permission) => {
        logSound('Notification permission result', { permission })
        if (permission === 'granted') {
          void registerNotificationServiceWorker()
        }
      })
      .catch((error) => logSound('Notification permission request failed', error))
    return
  }

  if (Notification.permission === 'granted') {
    void registerNotificationServiceWorker()
  }
}

export function ensureNotificationPermissionOnUserGesture() {
  if (typeof window === 'undefined') return
  if (gesturePermissionHookInstalled) return
  logSound('Installing gesture hook for notification/audio priming')
  gesturePermissionHookInstalled = true

  const cleanup = () => {
    logSound('Cleaning up gesture hook')
    window.removeEventListener('pointerdown', onGesture, true)
    window.removeEventListener('keydown', onGesture, true)
    window.removeEventListener('touchstart', onGesture, true)
    gesturePermissionHookInstalled = false
  }

  const onGesture = (event: Event) => {
    logSound('Gesture captured for permission/audio priming', {
      eventType: event.type,
      notificationSupported: isNotificationSupported(),
      permission: isNotificationSupported() ? Notification.permission : 'unavailable',
    })
    unlockAudioContext()
    primeTagAudioElement()
    primeTeleportAudioElement()
    if (isNotificationSupported() && Notification.permission === 'default') {
      logSound('Requesting notification permission from gesture handler')
      void Notification.requestPermission()
        .then((permission) => {
          logSound('Notification permission result from gesture', { permission })
          if (permission === 'granted') {
            void registerNotificationServiceWorker()
          }
        })
        .catch((error) => logSound('Gesture permission request failed', error))
        .finally(cleanup)
    } else {
      cleanup()
    }
  }

  window.addEventListener('pointerdown', onGesture, true)
  window.addEventListener('keydown', onGesture, true)
  window.addEventListener('touchstart', onGesture, true)
}
