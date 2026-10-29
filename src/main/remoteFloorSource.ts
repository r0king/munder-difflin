/**
 * The control page's view of the floor (devices phase 2, item 8): the
 * FloorSource that remoteFloor.ts serves. It is built from the same state
 * and actions the floor uses, so the hive cannot tell which surface a person
 * used. Everything is injected (FloorDeps), so
 * test/remote-floor-source.test.cjs drives it without Electron.
 */
import type { FloorActionResult, FloorAgentStatus, FloorMail, FloorQuestion, FloorSource, FloorState } from './remoteFloor';
import type { DeviceStatus } from '../shared/devices';
import { classifyHook, isTurnHook } from './workerWake';
import { answerHumanQA, answerMail, findRawTask } from '../shared/workspace/inboxAsk';

/** What an agent's hooks last said it is doing. */
export type Activity = 'working' | 'idle' | 'needs-you';

/** Fed from HookServer's onEvent observer, the one channel every engine has.
 *  A permission prompt holds "needs-you" until the next turn event. */
export class FloorActivity {
  private readonly state = new Map<string, Activity>();

  note(agentId: string | undefined, event: string, message: string | undefined): void {
    if (!agentId) return;
    const c = classifyHook(event, message);
    if (c === 'needsHuman') this.state.set(agentId, 'needs-you');
    else if (c === 'idle' || event === 'Stop' || event === 'StopFailure' || event === 'SessionStart') this.state.set(agentId, 'idle');
    else if (isTurnHook(event)) this.state.set(agentId, 'working');
  }

  get(agentId: string): Activity {
    return this.state.get(agentId) ?? 'idle';
  }
}

interface RegistryLike {
  godId: string | null;
  agents: Record<string, { name: string; role?: string; isGod?: boolean; archived?: boolean; device?: string }>;
}

interface MailLike { id: string; from: string; to: string; subject: string; body: string; created_at: string }

/** What src/main/index.ts hands the adapter: each member is the floor's own
 *  state or handler (see each line there). */
export interface FloorDeps {
  registry(): RegistryLike;
  tasks(): unknown;
  patchTask(id: string, patch: { humanQA: unknown[] }): boolean;
  send(msg: { to: string; act: 'inform'; subject: string; body: string }, from: string): unknown;
  /** Recent mail, bodies already redacted (hive.voiceMessages). */
  messages(limit: number): MailLike[];
  isGod(agentId: string): boolean;
  activity(agentId: string): Activity;
  /** Paused or halted (ControlRegistry). */
  paused(agentId: string): boolean;
  deliveryPaused(agentId: string): boolean;
  contextPct(agentId: string): number | null;
  costToday(agentId: string): number | null;
  devices(): DeviceStatus[];
  halt(agentId: string): void;
  restart(agentId: string): Promise<FloorActionResult>;
  setAutoDelivery(agentId: string, paused: boolean): void;
  /** analytics.trackMessageSent('hive'): the page's mail is a person's. */
  messageSent(): void;
  now?(): Date;
}

/** The subject of mail sent from the page's box. */
export const PAGE_MAIL_SUBJECT = 'Message from the human';
const MAIL_SHOWN = 30;

export function createFloorSource(d: FloorDeps): FloorSource & { changed(): void } {
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const l of listeners) { try { l(); } catch { /* a closed stream */ } }
  };
  const live = (id: string): boolean => {
    const a = d.registry().agents[id];
    return !!a && !a.archived;
  };
  const unknown: FloorActionResult = { ok: false, error: 'No such agent on the floor.' };
  const notOpen: FloorActionResult = { ok: false, error: 'That question is no longer open.' };

  function questions(): FloorQuestion[] {
    const ledger = d.tasks() as { tasks?: unknown };
    const out: FloorQuestion[] = [];
    for (const raw of Array.isArray(ledger?.tasks) ? ledger.tasks : []) {
      if (!raw || typeof raw !== 'object') continue;
      const task = raw as Record<string, unknown>;
      const qa = Array.isArray(task.humanQA) ? task.humanQA : [];
      qa.forEach((e, qIndex) => {
        if (!e || typeof e !== 'object') return;
        const { q, a, dismissedAt, askedAt } = e as Record<string, unknown>;
        // TasksKanban openQuestion(): a string q, no answer, not dismissed.
        if (typeof q !== 'string' || a || dismissedAt) return;
        out.push({
          taskId: String(task.id),
          taskTitle: typeof task.title === 'string' ? task.title : String(task.id),
          qIndex,
          q,
          ...(typeof askedAt === 'string' ? { askedAt } : {})
        });
      });
    }
    return out;
  }

  function mail(): FloorMail[] {
    const seen = new Set<string>();
    return d.messages(200)
      .filter((m) => [m.from, m.to].some((p) => p === 'human' || d.isGod(p)))
      // A message shows once, though it sits in a sender's outbox and a
      // recipient's inbox.
      .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
      .sort((x, y) => (x.created_at < y.created_at ? 1 : x.created_at > y.created_at ? -1 : 0))
      .slice(0, MAIL_SHOWN)
      .map((m) => ({ id: m.id, from: m.from, to: m.to, subject: m.subject, body: m.body, createdAt: m.created_at }));
  }

  function state(): FloorState {
    const reg = d.registry();
    const devs = d.devices();
    const linkState = new Map(devs.map((s) => [s.id, s.state]));
    const agents = Object.entries(reg.agents)
      .filter(([, a]) => !a.archived)
      .map(([id, a]) => {
        const status: FloorAgentStatus = d.paused(id)
          ? 'paused'
          : a.device && linkState.get(a.device) !== 'online' ? 'offline' : d.activity(id);
        return {
          id,
          name: a.name,
          role: a.role ?? (a.isGod ? 'orchestrator' : 'agent'),
          device: a.device || 'local',
          status,
          contextPct: d.contextPct(id),
          costTodayUsd: d.costToday(id),
          // Nothing records a session's Remote Control URL yet.
          remoteControlUrl: null,
          deliveryPaused: d.deliveryPaused(id)
        };
      });
    return { agents, questions: questions(), mail: mail(), devices: devs.map((s) => ({ id: s.id, name: s.id, state: s.state })) };
  }

  return {
    state,
    changed,
    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    // The Ask Me path, step for step (workspace/inbox/actions.ts answerAsk):
    // re-read the card, answer the question still open at that index, write
    // it, then mail god the same words.
    async answerQuestion(taskId, qIndex, text) {
      const task = findRawTask(d.tasks(), taskId);
      const entry = task && Array.isArray(task.humanQA) ? task.humanQA[qIndex] : undefined;
      const q = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).q : undefined;
      if (!task || typeof q !== 'string') return notOpen;
      const humanQA = answerHumanQA(task.humanQA, q, text, (d.now?.() ?? new Date()).toISOString());
      if (!humanQA) return notOpen;
      if (!d.patchTask(taskId, { humanQA })) return { ok: false, error: 'Could not write the task.' };
      d.send(answerMail({ id: taskId, title: typeof task.title === 'string' ? task.title : taskId }, q, text.trim()), 'human');
      changed();
      return { ok: true };
    },
    async sendMail(agentId, text) {
      const body = text.trim();
      if (!live(agentId)) return unknown;
      if (!body) return { ok: false, error: 'The message is empty.' };
      d.send({ to: agentId, act: 'inform', subject: PAGE_MAIL_SUBJECT, body }, 'human');
      d.messageSent();
      changed();
      return { ok: true };
    },
    async stopAgent(agentId) {
      if (!live(agentId)) return unknown;
      d.halt(agentId);
      changed();
      return { ok: true };
    },
    async restartAgent(agentId) {
      if (!live(agentId)) return unknown;
      const r = await d.restart(agentId);
      changed();
      return r;
    },
    async setAutoDelivery(agentId, paused) {
      if (!live(agentId)) return unknown;
      d.setAutoDelivery(agentId, paused);
      changed();
      return { ok: true };
    }
  };
}
