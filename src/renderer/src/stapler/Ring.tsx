/**
 * The ring: eight square buttons on a circle around the puck. Clockwise from
 * the top — Screenshot, Record message, Record meeting, Dictate, To, Settings,
 * Computer use (coming soon), Make invisible. The caption under the puck names
 * whatever is under the pointer, and otherwise says where things will go.
 */
import { useState } from 'react';
import { StaplerIcon, type StaplerIconName } from './icons';

export interface RingItem {
  id: string;
  icon: StaplerIconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** A toggle that is on (Make invisible, Dictate while dictating). */
  pressed?: boolean;
  /** Recording right now (drawn coral). */
  live?: boolean;
  /** A small count or marker in the corner. */
  mark?: string;
}

export const RING_SIZE = 288;
const RADIUS = 100;
const BUTTON = 44;

export function ringPosition(index: number, count: number): { left: number; top: number } {
  const angle = (index / count) * 2 * Math.PI - Math.PI / 2;
  const c = RING_SIZE / 2;
  return {
    left: Math.round(c + RADIUS * Math.cos(angle) - BUTTON / 2),
    top: Math.round(c + RADIUS * Math.sin(angle) - BUTTON / 2)
  };
}

export function Ring({ items, idleCaption }: { items: RingItem[]; idleCaption: string }) {
  const [hover, setHover] = useState<string | null>(null);
  const hovered = items.find((i) => i.id === hover);
  return (
    <>
      {items.map((item, i) => {
        const pos = ringPosition(i, items.length);
        return (
          <button
            key={item.id}
            type="button"
            data-stapler-hit=""
            className={`cth-stapler-ringbtn${item.live ? ' cth-stapler-ringbtn--live' : ''}`}
            style={{ left: pos.left, top: pos.top }}
            aria-label={item.label}
            aria-pressed={item.pressed === undefined ? undefined : item.pressed}
            // aria-disabled, not disabled: a disabled button gets no pointer
            // events, and "Computer use · Coming soon" must still say so on hover.
            aria-disabled={item.disabled ? true : undefined}
            onPointerEnter={() => setHover(item.id)}
            onPointerLeave={() => setHover((h) => (h === item.id ? null : h))}
            onFocus={() => setHover(item.id)}
            onBlur={() => setHover((h) => (h === item.id ? null : h))}
            onClick={() => { if (!item.disabled) item.onClick(); }}
          >
            <StaplerIcon name={item.icon} size={20} />
            {item.mark && <span className="cth-stapler-ringbtn-mark">{item.mark}</span>}
          </button>
        );
      })}
      <div className="cth-stapler-caption" style={{ top: RING_SIZE / 2 + 28 + 8 }} aria-live="polite">
        <span>{hovered ? hovered.label : idleCaption}</span>
      </div>
    </>
  );
}
