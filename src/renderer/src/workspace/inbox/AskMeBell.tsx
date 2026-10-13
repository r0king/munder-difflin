/**
 * The Ask me bell — "a bell appears only when one is waiting, and you answer
 * it without leaving the room you are in."
 *
 * Mounted once by the shell (Workspace.tsx `headerExtras`), so it sits in the
 * actions of every screen's header. Renders NOTHING while nothing waits on you;
 * otherwise a count, and a popover holding the same cards the Inbox's Ask me
 * section shows — answer, quick-reply or dismiss right there. Escape or a
 * click outside closes it and focus returns to the bell.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { watermark } from '@shared/workspace/inboxMessages';
import { agentSectionKey } from '@shared/workspace/inboxSection';
import { useWorkspace } from '../store';
import { Button, IconButton, WsIcon } from '../ui';
import { useInboxMail } from './mailStore';
import { useNameOf, useWaitingOnYou } from './model';
import { WaitingList } from './items';
import './inbox.css';

export function AskMeBell() {
  const { t } = useTranslation();
  const { items, tasks, loaded } = useWaitingOnYou();
  const { marks } = useInboxMail();
  const nameOf = useNameOf();
  const navigate = useWorkspace((s) => s.navigate);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement | null>(null);
  const bell = useRef<HTMLButtonElement | null>(null);
  const pop = useRef<HTMLDivElement | null>(null);
  const popId = useId();
  const count = items.length;

  // The last question answered closes the popover with the bell itself.
  useEffect(() => { if (count === 0) setOpen(false); }, [count]);

  useEffect(() => {
    if (!open) return;
    pop.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      bell.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  if (count === 0) return null;

  return (
    <span className="cth-ws-inbox-bellwrap" ref={wrap}>
      <button
        ref={bell}
        type="button"
        // The styled tip only while closed: an open popover says it already.
        className={open ? 'cth-ws-inbox-bell' : 'cth-ws-inbox-bell cth-tip'}
        data-tip={open ? undefined : t('wsInbox.bell.tip', { count })}
        aria-label={t('wsInbox.bell.aria', { count })}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <WsIcon name="bell" />
        {count}
      </button>
      {open && (
        <div
          ref={pop}
          id={popId}
          className="cth-ws-inbox-pop"
          role="dialog"
          aria-label={t('wsInbox.bell.title')}
          tabIndex={-1}
        >
          <div className="cth-ws-inbox-pop-head">
            <h2 className="cth-ws-inbox-pop-title">{t('wsInbox.bell.heading', { count })}</h2>
            <IconButton label={t('wsInbox.bell.close')} size="sm" onClick={() => { setOpen(false); bell.current?.focus(); }}>
              <WsIcon name="close" />
            </IconButton>
          </div>
          <div className="cth-ws-inbox-pop-body">
            <WaitingList
              items={items}
              tasks={tasks}
              nameOf={nameOf}
              loaded={loaded}
              compact
              marks={(agentId) => watermark(marks, agentSectionKey(agentId))}
            />
          </div>
          <div className="cth-ws-inbox-pop-foot">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setOpen(false); navigate({ kind: 'inbox', section: 'askme' }); }}
            >
              {t('wsInbox.bell.openInbox')}
            </Button>
          </div>
        </div>
      )}
    </span>
  );
}
