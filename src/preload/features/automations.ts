/**
 * `window.cth.features.automations` — owned by the `wsAutomations` unit.
 * Automations: schedules, context rules, webhooks.
 *
 * Only HOUSE RULES (the texts every agent reads before it starts) are new
 * storage, so they are the only calls here. Schedules, the compact/clear context
 * rules, webhooks and their deliveries go through the existing `window.cth`
 * calls Classic uses (listMissions, setContextTrigger, saveWebhooks,
 * decideTriggerHistory, …), so both interfaces edit one set of records.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron';
import type { HouseRule } from '../../shared/workspace/automationsRules';

export type { HouseRule } from '../../shared/workspace/automationsRules';

/** What a write resolves to. `rules` is always main's canonical list — adopt it
 *  either way (a refused write hands back what is actually stored). */
export type HouseRulesResult =
  | { ok: true; rules: HouseRule[] }
  | { ok: false; error: 'invalid' | 'full' | 'notFound' | 'writeFailed'; rules: HouseRule[] };

export const automationsApi = {
  listRules: (): Promise<HouseRule[]> => ipcRenderer.invoke('feat:automations:listRules'),
  /** Insert or update one rule (matched by id). Main validates and clips it; a
   *  rule with no text is stored switched off. */
  saveRule: (rule: HouseRule): Promise<HouseRulesResult> => ipcRenderer.invoke('feat:automations:saveRule', rule),
  deleteRule: (id: string): Promise<HouseRulesResult> => ipcRenderer.invoke('feat:automations:deleteRule', id),
  /** Any window's change, pushed to every app window. Returns the unsubscribe. */
  onRules: (cb: (rules: HouseRule[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, rules: HouseRule[]) => cb(rules);
    ipcRenderer.on('feat:automations:rules', listener);
    return () => ipcRenderer.removeListener('feat:automations:rules', listener);
  }
};
