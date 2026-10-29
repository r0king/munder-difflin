/**
 * Devices: other Linux machines that run agents for this floor
 * (docs/superpowers/specs/2026-10-29-devices-design.md). Shared by main,
 * preload and renderer, so the config shape and its validation live once.
 *
 * This laptop is the implicit device `local` and is never stored.
 */

export interface DeviceConfig {
  /** 'my-lap'; also the label on agent cards and part of the ControlPath. */
  id: string;
  /** Tailscale IP or name ('100.65.189.1'). */
  host: string;
  /** Login name on the device. Default: this laptop's username. */
  user?: string;
  /** Device loopback ports: base = SFTP, +1 = hooks, +2 = telemetry. Each
   *  device has its own loopback, so every device can use the same base. */
  portBase?: number;
}

export type DeviceState = 'offline' | 'connecting' | 'online';

export interface DeviceStatus {
  id: string;
  state: DeviceState;
  /** Why the last attempt failed, in words a person can act on. */
  error?: string;
}

/** One line of Settings → Devices → Check. `fix` is a command, shown on failure. */
export interface DeviceCheckItem {
  id: 'login' | 'claude' | 'node' | 'tmux' | 'sshfs' | 'mount' | 'folder';
  /** The agent folder, for `folder` items. */
  path?: string;
  ok: boolean;
  fix?: string;
}

export const LOCAL_DEVICE = 'local';
export const DEFAULT_PORT_BASE = 47990;
export const DEFAULT_OFFLINE_PAUSE_MIN = 10;

// An id ends up in a socket path (/run/user/<uid>/md-<id>.ctl must stay under
// 108 bytes) and on agent cards. A host and a user end up in ssh's argv,
// where a leading '-' would be read as an option (`-oProxyCommand=…`), so
// both are held to plain name characters.
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;
const USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;

/** '' and 'local' both mean this laptop; anything else is a device id. */
export function normalizeDeviceId(device: unknown): string | undefined {
  if (typeof device !== 'string') return undefined;
  const d = device.trim();
  return d && d !== LOCAL_DEVICE ? d : undefined;
}

/** Can `id` name a new device, given the ids already taken? */
export function isValidDeviceId(id: string, taken: string[] = []): boolean {
  return ID_RE.test(id) && id !== LOCAL_DEVICE && !taken.includes(id);
}

export function isValidDeviceHost(host: string): boolean {
  return HOST_RE.test(host);
}

export function isValidDeviceUser(user: string): boolean {
  return USER_RE.test(user);
}

/** Keep the well-formed entries of a device list, drop the rest. A bad
 *  optional field is dropped on its own; the device stays. */
export function normalizeDevices(raw: unknown): DeviceConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: DeviceConfig[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const { id, host, user, portBase } = r as Record<string, unknown>;
    if (typeof id !== 'string' || !isValidDeviceId(id, out.map((d) => d.id))) continue;
    if (typeof host !== 'string' || !isValidDeviceHost(host)) continue;
    const d: DeviceConfig = { id, host };
    if (typeof user === 'string' && isValidDeviceUser(user)) d.user = user;
    if (typeof portBase === 'number' && Number.isInteger(portBase) && portBase >= 1024 && portBase <= 65533) d.portBase = portBase;
    out.push(d);
  }
  return out;
}

/** A moved agent whose conversation could not follow it (devices phase 2,
 *  item 1): where it stayed (`local` = this laptop) and why. The agent
 *  started fresh, and the floor says so. */
export interface ConversationStayed {
  device: string;
  reason: 'offline' | 'missing' | 'failed';
}
