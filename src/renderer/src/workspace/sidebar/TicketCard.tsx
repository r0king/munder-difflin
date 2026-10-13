/**
 * Hover a ticket key in the sidebar for its details: title, column, who has
 * it, when it last changed, and the start of its description. Opens on hover
 * (after a short delay, so sweeping the pointer down the list does not flash
 * cards) and on keyboard focus; stays open while the pointer is over the card
 * itself, so its text can be selected.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  descriptionExcerpt,
  ticketLastUpdate,
  ticketStatus,
  ticketTitle,
  type LedgerCard
} from '@shared/workspace/sidebarTickets';
import { Popover, type PopoverAnchor } from './Popover';
import { relativeTime } from './format';

const OPEN_DELAY_MS = 300;
const CLOSE_DELAY_MS = 150;

/** Open/close timing shared by the chip (trigger) and the card. */
export function useHoverCard(): {
  anchor: PopoverAnchor | null;
  show: (el: HTMLElement, immediate?: boolean) => void;
  hide: (immediate?: boolean) => void;
  keep: () => void;
} {
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => clear, []);
  const show = useCallback((el: HTMLElement, immediate = false) => {
    clear();
    const open = () => {
      const edge = el.closest('.cth-ws-sidebar')?.getBoundingClientRect() ?? el.getBoundingClientRect();
      setAnchor({ kind: 'side', rect: el.getBoundingClientRect(), edge });
    };
    if (immediate) open();
    else timer.current = setTimeout(open, OPEN_DELAY_MS);
  }, []);
  const hide = useCallback((immediate = false) => {
    clear();
    if (immediate) setAnchor(null);
    else timer.current = setTimeout(() => setAnchor(null), CLOSE_DELAY_MS);
  }, []);
  return { anchor, show, hide, keep: clear };
}

export function TicketCard({ card, assigneeName, anchor, onClose, onKeep }: {
  card: LedgerCard;
  assigneeName: string | null;
  anchor: PopoverAnchor;
  onClose: () => void;
  onKeep: () => void;
}) {
  const { t, i18n } = useTranslation();
  const title = ticketTitle(card) || t('wsSidebar.ticket.untitled');
  const status = ticketStatus(card);
  const updated = ticketLastUpdate(card);
  const excerpt = descriptionExcerpt(card.description);
  return (
    <Popover
      anchor={anchor}
      onClose={onClose}
      role="tooltip"
      className="cth-ws-sidebar-ticket"
      closeOnOutside
      onPointerEnter={onKeep}
      onPointerLeave={onClose}
    >
      <span className="cth-ws-sidebar-ticket-key">{card.id}</span>
      <p className="cth-ws-sidebar-ticket-title">{title}</p>
      <dl className="cth-ws-sidebar-ticket-facts">
        <dt>{t('wsSidebar.ticket.status')}</dt>
        <dd>{t(`wsSidebar.ticket.statuses.${status}`)}</dd>
        <dt>{t('wsSidebar.ticket.assignee')}</dt>
        <dd>{assigneeName ?? t('wsSidebar.ticket.unassigned')}</dd>
        <dt>{t('wsSidebar.ticket.updated')}</dt>
        <dd title={updated ? new Date(updated).toLocaleString(i18n.language) : undefined}>
          {updated ? relativeTime(updated, Date.now(), i18n.language) : t('wsSidebar.ticket.never')}
        </dd>
      </dl>
      <p className="cth-ws-sidebar-ticket-desc">{excerpt || t('wsSidebar.ticket.noDescription')}</p>
    </Popover>
  );
}
