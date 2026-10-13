/**
 * The Stapler's settings: the puck's own options, then transcription (the
 * transcribe unit's TranscribeSettings) and dictation (the dictate unit's
 * DictateSettings). Rendered in the puck's settings panel and in the meetings
 * library in the main window — every value comes from main over IPC, so it is
 * the same in both places.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { StaplerEnv } from '@shared/features/stapler';
import { Button, Chip, KeyHint, Section, Toggle } from '@/workspace/ui';
import { setStaplerEnabled, useStaplerState } from '@/workspace/useStaplerState';
import { TranscribeSettings } from './TranscribeSettings';
import { DictateSettings } from './dictate/DictateSettings';
import { stapler } from './bridge';
import { StaplerIcon } from './icons';
import './stapler.css';

/** Electron accelerator → the KeyHint combo ('Shift+Command+Space' → Shift+Mod+Space). */
export function acceleratorCombo(accelerator: string): string {
  return accelerator
    .split('+')
    .map((k) => (/^(command|cmd|commandorcontrol|cmdorctrl)$/i.test(k) ? 'Mod' : k))
    .join('+');
}

export function StaplerSettings({ where }: { where: 'puck' | 'library' }) {
  const { t } = useTranslation();
  const state = useStaplerState();
  const [env, setEnv] = useState<StaplerEnv | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => stapler().getEnv().then((e) => { if (alive) setEnv(e); }, () => { /* main not ready */ });
    void load();
    // The macOS permission can change while the app runs (System Settings).
    const onFocus = () => { void load(); };
    window.addEventListener('focus', onFocus);
    return () => { alive = false; window.removeEventListener('focus', onFocus); };
  }, []);

  const shortcut = state.meetingShortcut;
  const shortcutHint = shortcut?.accelerator ?? (env?.platform === 'darwin' ? 'Shift+Command+Space' : 'Ctrl+Shift+Space');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--cth-space-5)' }}>
      <Section title={t('stapler.settings.puck')}>
        <div className="cth-stapler-setting">
          {where === 'library' && (
            <Toggle
              checked={state.enabled}
              onChange={(on) => { void setStaplerEnabled(on); }}
              label={t('stapler.settings.show')}
            />
          )}
          {where === 'library' && state.recording && state.enabled && (
            <p className="cth-stapler-help">{t('stapler.settings.stopFirst')}</p>
          )}
          <Toggle
            checked={state.invisible}
            disabled={!state.canHide}
            onChange={(on) => { void stapler().setInvisible(on); }}
            label={t('stapler.settings.invisible')}
          />
          <p className="cth-stapler-help">
            {state.canHide ? t('stapler.settings.invisibleHelp') : t('stapler.settings.invisibleUnsupported')}
          </p>
          <div className="cth-stapler-row">
            <Button
              size="sm"
              icon={<StaplerIcon name="reset" />}
              disabled={!state.enabled}
              onClick={() => { void stapler().resetPosition(); }}
            >
              {t('stapler.settings.reset')}
            </Button>
            <span className="cth-stapler-help">{t('stapler.settings.resetHelp')}</span>
          </div>
        </div>
      </Section>

      <Section title={t('stapler.settings.shortcut')}>
        <div className="cth-stapler-setting">
          <div className="cth-stapler-row">
            <KeyHint combo={acceleratorCombo(shortcutHint)} />
            <span className="cth-stapler-text">{t('stapler.settings.shortcutWhat')}</span>
          </div>
          {!shortcut && <p className="cth-stapler-help">{t('stapler.settings.shortcutOff')}</p>}
          {shortcut?.registered && !shortcut.error && <div><Chip tone="ok">{t('stapler.settings.shortcutOn')}</Chip></div>}
          {shortcut?.error && (
            <div className={`cth-stapler-notice${shortcut.error === 'wayland' ? '' : ' cth-stapler-notice--danger'}`}>
              <p>{t(`stapler.settings.shortcutError.${shortcut.error === 'wayland' || shortcut.error === 'taken' ? shortcut.error : 'failed'}`)}</p>
              {shortcut.error !== 'wayland' && (
                <div><Button size="sm" onClick={() => { void stapler().retryShortcut(); }}>{t('stapler.settings.retry')}</Button></div>
              )}
            </div>
          )}
        </div>
      </Section>

      <Section title={t('stapler.settings.screenshots')}>
        <div className="cth-stapler-setting">
          {env?.platform === 'darwin' && env.screenPermission !== 'granted' ? (
            <div className="cth-stapler-notice">
              <p>{t('stapler.permission.body')}</p>
              <div className="cth-stapler-row">
                <Button size="sm" variant="primary" onClick={() => { void stapler().openScreenSettings(); }}>
                  {t('stapler.permission.open')}
                </Button>
              </div>
              <p>{t('stapler.permission.relaunch')}</p>
            </div>
          ) : (
            <p className="cth-stapler-help">
              {env?.sessionType === 'wayland' ? t('stapler.settings.screenshotsWayland') : t('stapler.settings.screenshotsHelp')}
            </p>
          )}
        </div>
      </Section>

      {where === 'library' && state.meetingsDir && (
        <Section title={t('stapler.settings.meetingsFolder')}>
          <div className="cth-stapler-setting">
            <span className="cth-stapler-path">{state.meetingsDir}</span>
            <p className="cth-stapler-help">{t('stapler.settings.meetingsFolderHelp')}</p>
          </div>
        </Section>
      )}

      <Section title={t('stapler.settings.transcription')}>
        <TranscribeSettings />
      </Section>

      <Section title={t('stapler.settings.dictation')}>
        <DictateSettings />
      </Section>
    </div>
  );
}
