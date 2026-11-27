import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Send } from 'lucide-react';
import { api, type AppSettingsUpdate } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { flattenFolders, folderPathLabel } from '../utils/slicerInbox';
import { Card, CardContent, CardHeader } from './Card';
import { Toggle } from './Toggle';

/**
 * Settings → Virtual Printer: sending from OrcaSlicer (fork).
 *
 * OrcaSlicer uploads to Bambuddy as to an OctoPrint host. This card says how
 * to set that up, which library folder the uploads wait in, and whether a
 * one-click "Add to queue" from the import dialog waits for a manual start.
 */
export function SlicerUploadSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { hasPermission, loading: authLoading } = useAuth();
  const canRead = !authLoading && hasPermission('settings:read');
  const canUpdate = !authLoading && hasPermission('settings:update');
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const originRef = useRef<HTMLElement>(null);

  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, enabled: canRead });
  const { data: folders } = useQuery({
    queryKey: ['library-folders'],
    queryFn: () => api.getLibraryFolders(),
    enabled: canRead,
  });

  const save = useMutation({
    mutationFn: (update: AppSettingsUpdate) => api.updateSettings(update),
    onSuccess: (saved) => {
      queryClient.setQueryData(['settings'], saved);
      queryClient.invalidateQueries({ queryKey: ['ui-flags'] });
      showToast(t('settings.toast.settingsSaved'));
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  if (!canRead) return null;

  const origin = window.location.origin;
  const options = flattenFolders(folders).filter((o) => !(o.folder.is_external && o.folder.external_readonly));
  const folderId = settings?.slicer_inbox_folder_id ?? null;
  const selected = folderId !== null && options.some((o) => o.id === folderId) ? folderId : null;
  const disabled = !settings || !canUpdate || save.isPending;

  const copyOrigin = async () => {
    try {
      await navigator.clipboard.writeText(origin);
      setCopyFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard over plain http: select the address so it can be copied
      // by hand, and say so instead of doing nothing.
      const node = originRef.current;
      const selection = window.getSelection?.();
      if (node && selection) {
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setCopyFailed(true);
    }
  };

  return (
    <Card className="mt-4" id="card-slicer-upload">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Send className="w-5 h-5 text-bambu-green" />
          <h2 className="text-lg font-semibold text-white">{t('slicerUploadSettings.title')}</h2>
        </div>
        <p className="text-sm text-bambu-gray mt-2">{t('slicerUploadSettings.description')}</p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <h3 className="text-sm font-medium text-white mb-2">{t('slicerUploadSettings.setupTitle')}</h3>
          <ol className="list-decimal pl-5 space-y-1.5 text-sm text-bambu-gray">
            <li>{t('slicerUploadSettings.step1')}</li>
            <li>
              {t('slicerUploadSettings.step2')}
              <span className="mt-1 flex items-center gap-2">
                <code
                  ref={originRef}
                  className="rounded bg-bambu-dark px-2 py-1 font-mono text-xs text-white break-all select-all"
                >
                  {origin}
                </code>
                <button
                  type="button"
                  onClick={() => void copyOrigin()}
                  className="p-1 rounded text-bambu-gray hover:text-white hover:bg-bambu-dark inline-flex items-center justify-center any-pointer-coarse:min-h-[44px] any-pointer-coarse:min-w-[44px]"
                  title={t('slicerUploadSettings.copy')}
                  aria-label={t('slicerUploadSettings.copy')}
                >
                  {copied ? <Check className="w-4 h-4 text-bambu-green" /> : <Copy className="w-4 h-4" />}
                </button>
              </span>
              {copyFailed && (
                <span role="status" className="mt-1 block text-xs text-yellow-700 dark:text-yellow-400">
                  {t('slicerUploadSettings.copyFailed')}
                </span>
              )}
            </li>
            <li>{t('slicerUploadSettings.step3')}</li>
            <li>{t('slicerUploadSettings.step4')}</li>
          </ol>
        </div>

        <label className="block">
          <span className="block text-sm font-medium text-white">{t('slicerUploadSettings.inboxFolder')}</span>
          <span className="block text-xs text-bambu-gray mb-2">{t('slicerUploadSettings.inboxFolderHint')}</span>
          <select
            value={selected ?? ''}
            onChange={(e) => save.mutate({ slicer_inbox_folder_id: e.target.value ? Number(e.target.value) : null })}
            disabled={disabled}
            className="w-full sm:w-80 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-bambu-green disabled:opacity-60"
          >
            <option value="">{t('slicerUploadSettings.inboxFolderDefault')}</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {folderPathLabel(option)}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-white">{t('slicerUploadSettings.manualStart')}</p>
            <p className="text-xs text-bambu-gray">{t('slicerUploadSettings.manualStartHint')}</p>
          </div>
          <Toggle
            checked={settings?.slicer_inbox_manual_start ?? false}
            onChange={(checked) => save.mutate({ slicer_inbox_manual_start: checked })}
            disabled={disabled}
          />
        </div>
      </CardContent>
    </Card>
  );
}
