import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, PlugZap, ShoppingBag, X } from 'lucide-react';
import { api } from '../../api/client';
import type { BaseConnectionInfo, BaseSyncSettingsUpdate } from '../../api/client';
import { Card, CardContent } from '../Card';
import { Button } from '../Button';
import { NumberInput } from '../NumberInput';
import { parseUTCDate, toDateTimeLocalValue } from '../../utils/date';
import { useToast } from '../../contexts/ToastContext';
import { useModalBehavior } from '../../hooks/useModalBehavior';
import { useDiscardGuard } from './useDiscardGuard';

interface BaseSettingsModalProps {
  onClose: () => void;
  onSaved: () => void;
}

const inputClass =
  'w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white placeholder-bambu-gray text-sm focus:border-bambu-green focus:outline-none';

/** Fork (Base sync): connect Base and choose where orders come from. Read-only towards Base. */
export function BaseSettingsModal({ onClose, onSaved }: BaseSettingsModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { data: settings, isLoading } = useQuery({ queryKey: ['base-sync', 'settings'], queryFn: api.getBaseSyncSettings });
  const [token, setToken] = useState('');
  const [info, setInfo] = useState<BaseConnectionInfo | null>(null);
  const [draft, setDraft] = useState<BaseSyncSettingsUpdate | null>(null);
  // Local date and time in the field; empty takes every order (Base's 3 months).
  const [since, setSince] = useState<string | null>(null);
  // The form as loaded, to tell whether Escape would lose changes.
  const [baseline, setBaseline] = useState<string | null>(null);

  useEffect(() => {
    if (settings && draft === null) {
      const initial: BaseSyncSettingsUpdate = {
        enabled: settings.enabled,
        status_ids: settings.status_ids,
        cancel_status_id: settings.cancel_status_id,
        sources: settings.sources,
        poll_minutes: settings.poll_minutes,
        auto_accept: settings.auto_accept,
        manual_start: settings.manual_start,
        handling_days: settings.handling_days,
      };
      setDraft(initial);
      const stored = parseUTCDate(settings.since);
      // A new setup starts from now, so orders handled before do not turn up.
      const initialSince =
        stored ? toDateTimeLocalValue(stored) : settings.status_ids.length === 0 ? toDateTimeLocalValue(new Date()) : '';
      setSince(initialSince);
      setBaseline(JSON.stringify([initial, initialSince]));
    }
  }, [settings, draft]);

  const dirty = token.trim() !== '' || (baseline !== null && JSON.stringify([draft, since]) !== baseline);
  const { requestClose, confirm } = useDiscardGuard(dirty, onClose);
  const overlayRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const testMutation = useMutation({
    // The variables only tell onSuccess whether to say so.
    mutationFn: (options: { quiet: boolean }) => {
      void options;
      return api.testBaseConnection(token.trim() || undefined);
    },
    onSuccess: (result, { quiet }) => {
      setInfo(result);
      if (!quiet) showToast(t('baseSync.settings.connected'), 'success');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  // With a stored token the choices load at once, quietly and only once.
  const loaded = useRef(false);
  useEffect(() => {
    if (settings?.token_set && !loaded.current) {
      loaded.current = true;
      testMutation.mutate({ quiet: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the settings arrive
  }, [settings?.token_set]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const body: BaseSyncSettingsUpdate = { ...draft };
      if (body.cancel_status_id == null) {
        delete body.cancel_status_id;
        body.clear_cancel_status = true;
      }
      if (token.trim()) body.api_token = token.trim();
      if (since) body.since = new Date(since).toISOString();
      else body.clear_since = true;
      return api.updateBaseSyncSettings(body);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(['base-sync', 'settings'], saved);
      onSaved();
      showToast(t('baseSync.settings.saved'), 'success');
      onClose();
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  // Escape asks before dropping changes, and waits for a save under way.
  useModalBehavior(requestClose, overlayRef, saveMutation.isPending);

  const set = (patch: BaseSyncSettingsUpdate) => setDraft((current) => ({ ...(current ?? {}), ...patch }));
  const sources = draft?.sources ?? [];
  const statusIds = draft?.status_ids ?? [];

  return (
    <div ref={overlayRef} className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <Card
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="outline-none w-full max-w-xl max-h-[90vh] flex flex-col"
      >
        <CardContent className="p-0 flex flex-col min-h-0">
          <div className="flex items-center justify-between p-4 border-b border-bambu-dark-tertiary shrink-0">
            <div className="flex items-center gap-2">
              <ShoppingBag className="w-5 h-5 text-bambu-green" />
              <h2 id={titleId} className="text-lg font-semibold text-white">{t('baseSync.settings.title')}</h2>
            </div>
            <button onClick={onClose} className="text-bambu-gray hover:text-white" aria-label={t('common.close')}>
              <X className="w-5 h-5" />
            </button>
          </div>
          {isLoading || !draft ? (
            <div className="flex justify-center p-8">
              <Loader2 className="w-6 h-6 animate-spin text-bambu-gray" />
            </div>
          ) : (
            <div className="p-4 space-y-4 overflow-y-auto min-h-0">
              <p className="text-xs text-bambu-gray">{t('baseSync.settings.readOnly')}</p>
              <label className="block">
                <span className="block text-sm text-bambu-gray mb-1">{t('baseSync.settings.token')}</span>
                <div className="flex gap-2">
                  <input
                    type="password"
                    autoComplete="off"
                    className={inputClass}
                    value={token}
                    placeholder={settings?.token_set ? t('baseSync.settings.tokenSet') : t('baseSync.settings.tokenPlaceholder')}
                    onChange={(e) => setToken(e.target.value)}
                  />
                  <Button
                    variant="secondary"
                    onClick={() => testMutation.mutate({ quiet: false })}
                    disabled={testMutation.isPending || (!token.trim() && !settings?.token_set)}
                  >
                    {testMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlugZap className="w-4 h-4" />}
                    {t('baseSync.settings.test')}
                  </Button>
                </div>
                <span className="block text-xs text-bambu-gray mt-1">{t('baseSync.settings.tokenHint')}</span>
              </label>

              {info && (
                <>
                  <fieldset>
                    <legend className="text-sm text-bambu-gray mb-1">{t('baseSync.settings.statuses')}</legend>
                    <p className="text-xs text-bambu-gray mb-2">{t('baseSync.settings.statusesHint')}</p>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {info.statuses.map((s) => (
                        <label key={s.id} className="flex items-center gap-2 text-sm text-white min-w-0">
                          <input
                            type="checkbox"
                            checked={statusIds.includes(s.id)}
                            onChange={(e) =>
                              set({
                                status_ids: e.target.checked
                                  ? [...statusIds, s.id]
                                  : statusIds.filter((id) => id !== s.id),
                              })
                            }
                          />
                          {s.color && (
                            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                          )}
                          <span className="truncate">{s.name}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <label className="block">
                    <span className="block text-sm text-bambu-gray mb-1">{t('baseSync.settings.cancelStatus')}</span>
                    <select
                      className={inputClass}
                      value={draft.cancel_status_id ?? ''}
                      onChange={(e) => set({ cancel_status_id: e.target.value ? Number(e.target.value) : null })}
                    >
                      <option value="">{t('baseSync.settings.none')}</option>
                      {info.statuses.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <fieldset>
                    <legend className="text-sm text-bambu-gray mb-1">{t('baseSync.settings.sources')}</legend>
                    <p className="text-xs text-bambu-gray mb-2">{t('baseSync.settings.sourcesHint')}</p>
                    <div className="flex flex-wrap gap-3">
                      {info.sources.map((source) => (
                        <label key={source.key} className="flex items-center gap-1.5 text-sm text-white">
                          <input
                            type="checkbox"
                            checked={sources.includes(source.key)}
                            onChange={(e) =>
                              set({
                                sources: e.target.checked
                                  ? [...sources, source.key]
                                  : sources.filter((key) => key !== source.key),
                              })
                            }
                          />
                          {source.name} <span className="text-xs text-bambu-gray">({source.key.split(':')[0]})</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </>
              )}

              <label className="block">
                <span className="block text-sm text-bambu-gray mb-1">{t('baseSync.settings.since')}</span>
                <input
                  type="datetime-local"
                  className={inputClass}
                  value={since ?? ''}
                  onChange={(e) => setSince(e.target.value)}
                />
                <span className="block text-xs text-bambu-gray mt-1">{t('baseSync.settings.sinceHint')}</span>
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="block text-sm text-bambu-gray mb-1">{t('baseSync.settings.poll')}</span>
                  <NumberInput
                    min={2}
                    max={1440}
                    fallback={5}
                    className={inputClass}
                    value={draft.poll_minutes ?? 5}
                    onChange={(poll_minutes) => set({ poll_minutes })}
                  />
                </label>
                <label className="block">
                  <span className="block text-sm text-bambu-gray mb-1">{t('baseSync.settings.handling')}</span>
                  <NumberInput
                    min={0}
                    max={60}
                    fallback={0}
                    className={inputClass}
                    value={draft.handling_days ?? 0}
                    onChange={(handling_days) => set({ handling_days })}
                  />
                </label>
              </div>
              <div className="space-y-2">
                {(
                  [
                    ['enabled', 'baseSync.settings.enabled'],
                    ['auto_accept', 'baseSync.settings.autoAccept'],
                    ['manual_start', 'baseSync.settings.manualStart'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="flex items-start gap-2 text-sm text-white">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={!!draft[key]}
                      onChange={(e) => set({ [key]: e.target.checked })}
                    />
                    <span>
                      {t(label)}
                      <span className="block text-xs text-bambu-gray">{t(`${label}Hint`)}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2 p-4 border-t border-bambu-dark-tertiary shrink-0">
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => saveMutation.mutate()} disabled={!draft || saveMutation.isPending}>
              {saveMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('common.save')}
            </Button>
          </div>
        </CardContent>
      </Card>
      {confirm}
    </div>
  );
}
