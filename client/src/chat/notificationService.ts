const LAST_NOTIFICATION_BY_KEY = new Map<string, number>()
const DEFAULT_COOLDOWN_MS = 3000

function isNotificationSupported() {
  return typeof window !== 'undefined' && 'Notification' in window
}

export function shouldNotifyHiddenTab(key: string, cooldownMs = DEFAULT_COOLDOWN_MS) {
  if (typeof document === 'undefined') return false
  if (document.visibilityState === 'visible') return false
  if (!isNotificationSupported()) return false
  if (Notification.permission !== 'granted') return false

  const now = Date.now()
  const lastNotifiedAt = LAST_NOTIFICATION_BY_KEY.get(key)
  if (lastNotifiedAt !== undefined && now - lastNotifiedAt < cooldownMs) return false

  LAST_NOTIFICATION_BY_KEY.set(key, now)
  return true
}

export function showBrowserNotification(title: string, body: string) {
  if (!isNotificationSupported() || Notification.permission !== 'granted') return

  const notification = new Notification(title, { body })
  notification.onclick = () => {
    window.focus()
    notification.close()
  }
}

export function maybeRequestNotificationPermission() {
  if (!isNotificationSupported()) return
  if (Notification.permission === 'default') {
    void Notification.requestPermission()
  }
}
