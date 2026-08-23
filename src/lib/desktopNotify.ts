/**
 * Pure gate for desktop (Web Notification API) notifications (#52). The hook
 * `useDesktopNotifications` owns the permission/enabled state and the actual
 * `new Notification(...)`; this DOM-free predicate decides whether a notification
 * should fire, so the policy is unit-tested in isolation.
 *
 * A notification only fires when the user enabled it, the browser granted
 * permission, AND the page is hidden — a backgrounded tab is exactly when a
 * desktop notice is useful; while the tab is focused the in-app toast suffices.
 */
export type NotifyPermission = NotificationPermission | "unsupported";

export interface NotifyGate {
  /** The user's opt-in toggle. */
  enabled: boolean;
  /** The browser's Notification permission (or "unsupported"). */
  permission: NotifyPermission;
  /** Whether the page is currently hidden (backgrounded). */
  hidden: boolean;
}

/** Whether a notification should be shown for the current gate state. */
export function canNotify({
  enabled,
  permission,
  hidden,
}: NotifyGate): boolean {
  return enabled && permission === "granted" && hidden;
}
