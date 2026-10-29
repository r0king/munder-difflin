/**
 * Devices in the renderer: each device's live link state, pushed from main
 * (`devices:state`, seeded by `listDevices` in useHive), plus the two rules
 * Settings → Devices and the agent cards share.
 */
import { create } from 'zustand';
import { LOCAL_DEVICE, type ConversationStayed, type DeviceStatus } from '@shared/devices';

export const useDeviceStates = create<{ states: Record<string, DeviceStatus> }>(() => ({ states: {} }));

export function setDeviceStatus(s: DeviceStatus): void {
  useDeviceStates.setState((prev) => ({ states: { ...prev.states, [s.id]: s } }));
}

/** Is the device still someone's home (on the floor or waiting to be
 *  restored)? Settings refuses to remove it while it is. */
export function deviceInUse(agents: Array<{ device?: string }>, id: string): boolean {
  return agents.some((a) => a.device === id);
}

/** A card greys out ("offline · reconnecting") unless its device is online. */
export function deviceOffline(device: string | undefined, states: Record<string, DeviceStatus>): boolean {
  return !!device && states[device]?.state !== 'online';
}

/** The card caption when a moved agent's conversation could not follow it. */
export function conversationStayedText(
  t: (key: string, opts?: Record<string, unknown>) => string,
  s: ConversationStayed
): string {
  return t('devices.conversationStayed', {
    device: s.device === LOCAL_DEVICE ? t('devices.thisLaptop') : s.device,
    reason: t(`devices.stayedReason.${s.reason}`)
  });
}
