/**
 * The tray of staged changes and the one Send that hands them all to the
 * orchestrator. Shown while anything is staged, and briefly after a send to
 * confirm it went (the cards then move when he writes the ledger, not before).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { StagedMove } from '@shared/workspace/tasksMoves';
import { Button, WsIcon } from '../ui';
import { COLUMN_META } from './meta';

export interface SendBarProps {
  staged: readonly StagedMove[];
  nameOf: (agentId: string) => string | undefined;
  sending: boolean;
  error: string | null;
  /** Count of the last successful send, while its confirmation shows. */
  sentCount: number | null;
  /** The orchestrator is not on the floor: the message will wait in his queue. */
  godAway: boolean;
  onSend: () => void;
  onDiscard: () => void;
  onUndo: (taskId: string) => void;
}

export function SendBar({ staged, nameOf, sending, error, sentCount, godAway, onSend, onDiscard, onUndo }: SendBarProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!staged.length && sentCount === null && !error) return null;
  const owner = (id: string | null) => (id ? nameOf(id) ?? id : t('wsTasks.unassigned'));
  const col = (c: StagedMove['toColumn']) => t(COLUMN_META[c].labelKey);

  return (
    <div className="cth-ws-tasks-sendbar" role="region" aria-label={t('wsTasks.send.region')}>
      {open && staged.length > 0 && (
        <ul className="cth-ws-tasks-sendbar-list">
          {staged.map((m) => (
            <li key={m.taskId} className="cth-ws-tasks-sendbar-item">
              <span className="cth-ws-tasks-card-id">{m.taskId}</span>
              <span className="cth-ws-ellipsis" style={{ flex: 1 }} dir="auto">{m.title}</span>
              <span className="cth-ws-tasks-nowrap">
                {m.fromColumn !== m.toColumn && t('wsTasks.send.columnChange', { from: col(m.fromColumn), to: col(m.toColumn) })}
                {m.fromColumn !== m.toColumn && (m.fromOwner ?? null) !== (m.toOwner ?? null) && ' · '}
                {(m.fromOwner ?? null) !== (m.toOwner ?? null) && t('wsTasks.send.ownerChange', { from: owner(m.fromOwner), to: owner(m.toOwner) })}
              </span>
              <Button variant="ghost" size="sm" onClick={() => onUndo(m.taskId)}>{t('wsTasks.pending.undo')}</Button>
            </li>
          ))}
        </ul>
      )}
      <div className="cth-ws-tasks-sendbar-row">
        {staged.length > 0 ? (
          <>
            <span className="cth-ws-tasks-sendbar-text">
              {staged.length === 1 ? t('wsTasks.send.stagedOne') : t('wsTasks.send.stagedMany', { count: staged.length })}
              {' '}
              <span className="cth-ws-tasks-sendbar-hint">
                {godAway ? t('wsTasks.send.hintAway') : t('wsTasks.send.hint')}
              </span>
            </span>
            {error && <span className="cth-ws-tasks-sendbar-error" role="alert">{t('wsTasks.send.failed', { error })}</span>}
            <Button
              variant="ghost"
              size="sm"
              icon={<WsIcon name={open ? 'chevron-down' : 'chevron-right'} />}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? t('wsTasks.send.hide') : t('wsTasks.send.review')}
            </Button>
            <Button variant="ghost" size="sm" onClick={onDiscard} disabled={sending}>{t('wsTasks.send.discard')}</Button>
            <Button variant="primary" icon={<WsIcon name="send" />} onClick={onSend} disabled={sending}>
              {sending ? t('wsTasks.send.sending') : t('wsTasks.send.send')}
            </Button>
          </>
        ) : sentCount !== null ? (
          <span className="cth-ws-tasks-sendbar-text" role="status">
            {sentCount === 1 ? t('wsTasks.send.sentOne') : t('wsTasks.send.sentMany', { count: sentCount })}
          </span>
        ) : (
          error && <span className="cth-ws-tasks-sendbar-error" role="alert">{error}</span>
        )}
      </div>
    </div>
  );
}
