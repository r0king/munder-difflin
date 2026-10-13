/**
 * Keys for the whole desk, Workspace only (App passes `enabled`):
 *
 *   Mod+\   show/hide the sidebar
 *   Mod+,   Settings (the existing `cth:open-settings` event)
 *   Mod+.   the selected agent's room (god's is the orchestrator screen)
 *   Mod+I   open the IDE on the agent on screen
 *
 * Mod is ⌘ on the Mac and Ctrl elsewhere — never both: on the Mac a Ctrl combo
 * is terminal input (Ctrl+\ is SIGQUIT), so it is left alone entirely.
 *
 * THE TERMINAL RULE. On Windows and Linux these are Ctrl combos, and inside an
 * xterm some of them ARE keystrokes the agent's TUI should get: Ctrl+\ is
 * SIGQUIT and Ctrl+I is Tab. So while focus is in a terminal, only Ctrl+, and
 * Ctrl+. (which encode to nothing a TUI uses) are taken. In a code editor
 * (Monaco, CodeMirror) Ctrl/⌘+I is the editor's own, so it is left to it. Text
 * fields keep everything else app-level: none of the four edits text.
 *
 * Listens in the bubble phase on window, after xterm's own handler, and only
 * acts on an event nothing else has claimed (defaultPrevented). Repeats, IME
 * composition and Alt/Shift variants are ignored — Option+key is the
 * hold-to-talk gesture's territory (freeflow/holdOption).
 */
import { useEffect } from 'react';
import { useStore } from '@/store/store';
import { useWorkspace } from './store';

type DeskKey = 'sidebar' | 'settings' | 'room' | 'ide';

function deskKeyFor(e: KeyboardEvent): DeskKey | null {
  // e.code where the key is a symbol: `\`, `,` and `.` move around on non-US
  // layouts, and Shift/AltGr would change e.key anyway.
  switch (e.code) {
    case 'Backslash': return 'sidebar';
    case 'Comma': return 'settings';
    case 'Period': return 'room';
    case 'KeyI': return 'ide';
    default: return null;
  }
}

function focusContext(target: EventTarget | null): 'terminal' | 'editor' | 'other' {
  const el = target instanceof Element ? target : null;
  if (!el) return 'other';
  if (el.closest('.xterm')) return 'terminal';
  if (el.closest('.monaco-editor, .cm-editor')) return 'editor';
  return 'other';
}

export function useWorkspaceShortcuts(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const mac = window.cth?.platform === 'darwin';
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.repeat || e.isComposing) return;
      if (e.altKey || e.shiftKey) return;
      const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod) return;
      const key = deskKeyFor(e);
      if (!key) return;
      const where = focusContext(e.target);
      if (!mac && where === 'terminal' && (key === 'sidebar' || key === 'ide')) return;
      if (where === 'editor' && key === 'ide') return;

      const ws = useWorkspace.getState();
      const hive = useStore.getState();
      e.preventDefault();
      switch (key) {
        case 'sidebar':
          ws.toggleSidebar();
          return;
        case 'settings':
          window.dispatchEvent(new CustomEvent('cth:open-settings', { detail: {} }));
          return;
        case 'room': {
          const sel = hive.agents.find((a) => a.id === hive.selectedId);
          ws.navigate(sel && !sel.isGod ? { kind: 'agent', agentId: sel.id } : { kind: 'orchestrator' });
          return;
        }
        case 'ide': {
          if (hive.ideOpen) return;
          const route = ws.route;
          const god = hive.agents.find((a) => a.isGod);
          const agentId = route.kind === 'agent' ? route.agentId
            : route.kind === 'orchestrator' ? god?.id ?? null
              : hive.selectedId;
          hive.setIdeOpen(true, agentId);
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
