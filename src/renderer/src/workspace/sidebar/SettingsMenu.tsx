/**
 * The sidebar's own settings, behind the gear at its foot: "Keep my agent
 * order" and "Agents and notes only". Switches save at once (the Workspace
 * has no Save buttons); both live in localStorage via sidebarPrefs.
 */
import { useTranslation } from 'react-i18next';
import { Button, Toggle } from '../ui';
import { Popover, type PopoverAnchor } from './Popover';
import { useHiveSidebarState, useSidebarPrefs } from './sidebarPrefs';

export function SettingsMenu({ anchor, hiveKey, onClose, toggleRef }: {
  anchor: PopoverAnchor;
  hiveKey: string;
  onClose: () => void;
  toggleRef?: { current: HTMLElement | null };
}) {
  const { t } = useTranslation();
  const keepOrder = useSidebarPrefs((s) => s.keepOrder);
  const agentsNotesOnly = useSidebarPrefs((s) => s.agentsNotesOnly);
  const setKeepOrder = useSidebarPrefs((s) => s.setKeepOrder);
  const setAgentsNotesOnly = useSidebarPrefs((s) => s.setAgentsNotesOnly);
  const resetOrder = useSidebarPrefs((s) => s.resetOrder);
  const hive = useHiveSidebarState(hiveKey);
  const hasSavedOrder = hive.agents.length > 0 || hive.projects.length > 0;

  return (
    <Popover anchor={anchor} onClose={onClose} role="dialog" ariaLabel={t('wsSidebar.settings.title')} autoFocus toggleRef={toggleRef}>
      <div className="cth-ws-sidebar-settings">
        <div className="cth-ws-sidebar-menuhead" style={{ padding: 0 }}>{t('wsSidebar.settings.title')}</div>
        <Toggle checked={keepOrder} onChange={setKeepOrder} label={t('wsSidebar.settings.keepOrder')} />
        <p className="cth-ws-sidebar-settings-hint">
          {keepOrder ? t('wsSidebar.settings.keepOrderOn') : t('wsSidebar.settings.keepOrderOff')}
        </p>
        {keepOrder && hasSavedOrder && (
          <div style={{ paddingInlineStart: 36 }}>
            <Button size="sm" variant="ghost" onClick={() => resetOrder(hiveKey)}>{t('wsSidebar.settings.resetOrder')}</Button>
          </div>
        )}
        <Toggle checked={agentsNotesOnly} onChange={setAgentsNotesOnly} label={t('wsSidebar.settings.agentsNotesOnly')} />
        <p className="cth-ws-sidebar-settings-hint">{t('wsSidebar.settings.agentsNotesOnlyHint')}</p>
      </div>
    </Popover>
  );
}
