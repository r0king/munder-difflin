/**
 * New task: writes one card to the ledger (hiveAddTask, which appends against
 * main's latest on-disk copy — never a re-write of our snapshot), then, unless
 * told not to, lets the orchestrator know so the card gets dispatched. The id
 * follows the ledger's own key (bmt-19 on a bmt-18 floor), or the hive
 * folder's key when there is none yet.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ledgerCards, MAX_TASK_DESCRIPTION, MAX_TASK_TITLE, nextTaskId, rawTaskId } from '@shared/workspace/tasks';
import { buildNewTaskMessage } from '@shared/workspace/tasksMoves';
import { deliverToAgent } from '../deliver';
import { refreshHiveTasks } from '../useHiveTasks';
import { Button, Toggle } from '../ui';
import type { AgentOption } from './useTaskBoard';

export interface NewTaskDialogProps {
  owners: readonly AgentOption[];
  folderKey: string;
  nameOf: (agentId: string) => string | undefined;
  onClose: () => void;
  /** The card landed. `told` is false when the orchestrator note failed. */
  onCreated: (result: { id: string; told: boolean; tellError?: string }) => void;
}

/** Fresh ids straight from main — the dialog's own snapshot may be 5s old. */
async function currentIds(): Promise<string[]> {
  try {
    return ledgerCards(await window.cth.hiveTasks())
      .map((c, i) => (c && typeof c === 'object' && !Array.isArray(c) ? rawTaskId(c as Record<string, unknown>, i) : ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function NewTaskDialog({ owners, folderKey, nameOf, onClose, onCreated }: NewTaskDialogProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState('');
  const [tell, setTell] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<Element | null>(null);

  useEffect(() => {
    restoreFocus.current = document.activeElement;
    titleRef.current?.focus();
    return () => { (restoreFocus.current as HTMLElement | null)?.focus?.(); };
  }, []);

  const dirty = !!(title.trim() || description.trim());
  const canSubmit = !!title.trim() && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const card = {
      title: title.trim().slice(0, MAX_TASK_TITLE),
      description: description.trim() ? description.trim().slice(0, MAX_TASK_DESCRIPTION) : undefined,
      assignee: assignee || undefined,
      status: 'todo' as const,
      dependsOn: [] as string[],
      priority: 3,
      createdAt: new Date().toISOString()
    };
    try {
      // Two tries: if another writer took our id between the read and the
      // append (hiveAddTask refuses duplicates), re-read and take the next.
      let id = '';
      let landed = false;
      for (let attempt = 0; attempt < 2 && !landed; attempt++) {
        id = nextTaskId(await currentIds(), folderKey);
        const res = await window.cth.hiveAddTask({ id, ...card });
        landed = res.ok;
        if (!res.ok && attempt === 1) throw new Error(res.error || t('wsTasks.newTask.failedGeneric'));
      }
      void refreshHiveTasks();
      let told = true;
      let tellError: string | undefined;
      if (tell) {
        const res = await deliverToAgent({
          target: { kind: 'orchestrator' },
          text: buildNewTaskMessage({ id, ...card }, nameOf),
          mode: 'queue',
          source: 'tasks'
        });
        told = res.ok;
        tellError = res.error;
      }
      onCreated({ id, told, tellError });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div
      className="cth-ws-tasks-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !dirty && !busy) onClose(); }}
    >
      <form
        className="cth-ws-tasks-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cth-ws-tasks-new-title"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape' && !busy) { e.preventDefault(); e.stopPropagation(); onClose(); }
          else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
          else if (e.key === 'Tab') {
            // Keep Tab inside the dialog (it is modal).
            const items = [...e.currentTarget.querySelectorAll<HTMLElement>('input, textarea, select, button:not(:disabled)')];
            if (!items.length) return;
            const first = items[0];
            const last = items[items.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
          }
        }}
      >
        <h2 id="cth-ws-tasks-new-title">{t('wsTasks.newTask.heading')}</h2>
        <label className="cth-ws-tasks-field">
          <span className="cth-ws-tasks-field-label">{t('wsTasks.newTask.title')}</span>
          <input
            ref={titleRef}
            className="cth-ws-tasks-input"
            value={title}
            maxLength={MAX_TASK_TITLE}
            placeholder={t('wsTasks.newTask.titlePlaceholder')}
            dir="auto"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="cth-ws-tasks-field">
          <span className="cth-ws-tasks-field-label">{t('wsTasks.newTask.description')}</span>
          <textarea
            className="cth-ws-tasks-input"
            value={description}
            maxLength={MAX_TASK_DESCRIPTION}
            placeholder={t('wsTasks.newTask.descriptionPlaceholder')}
            dir="auto"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="cth-ws-tasks-field">
          <span className="cth-ws-tasks-field-label">{t('wsTasks.newTask.assignee')}</span>
          <select className="cth-ws-tasks-select" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">{t('wsTasks.unassigned')}</option>
            {owners.filter((o) => o.live).map((o) => (
              <option key={o.id} value={o.id}>{o.isGod ? t('wsTasks.ownerGod', { name: o.name }) : o.name}</option>
            ))}
          </select>
        </label>
        <Toggle checked={tell} onChange={setTell} label={t('wsTasks.newTask.tell')} />
        <div className="cth-ws-tasks-dialog-foot">
          {error && <span className="cth-ws-tasks-dialog-error" role="alert">{t('wsTasks.newTask.failed', { error })}</span>}
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('wsTasks.newTask.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={!canSubmit}>
            {busy ? t('wsTasks.newTask.creating') : t('wsTasks.newTask.create')}
          </Button>
        </div>
      </form>
    </div>
  );
}
