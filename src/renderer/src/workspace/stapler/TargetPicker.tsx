/**
 * "Send to…" for the meetings library: a button that opens the Stapler's To
 * list in a popover, built from the main window's own roster (this is an app
 * window, so the hive store is the live source).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { buildRoster } from '@/workspace/useFeatureBridge';
import { Button } from '@/workspace/ui';
import { TargetList } from '@/stapler/TargetList';
import { StaplerIcon } from '@/stapler/icons';
import type { StaplerTarget } from '@shared/features/stapler';

export function TargetPicker({ onPick, disabled, label }: {
  onPick: (target: StaplerTarget) => void;
  disabled?: boolean;
  label: string;
}) {
  const { t } = useTranslation();
  const agents = useStore((s) => s.agents);
  const roster = useMemo(() => buildRoster(agents), [agents]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); } };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={box} style={{ position: 'relative', display: 'inline-flex' }}>
      <Button size="sm" variant="primary" icon={<StaplerIcon name="send" />} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        {label}
      </Button>
      {open && (
        <div className="cth-stapler-popover" style={{ top: 32, insetInlineEnd: 0 }} role="dialog" aria-label={t('stapler.to.title')}>
          <TargetList
            roster={roster}
            value={null}
            autoFocus
            onPick={(target) => { setOpen(false); onPick(target); }}
          />
        </div>
      )}
    </div>
  );
}
