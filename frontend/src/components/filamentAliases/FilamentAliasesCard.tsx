import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Loader2, Plus, Trash2, X } from 'lucide-react';
import { api } from '../../api/client';
import type { FilamentAliases } from '../../api/client';
import { Card, CardContent, CardHeader } from '../Card';
import { Button } from '../Button';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { FILAMENT_ALIASES_QUERY_KEY } from '../../hooks/useFilamentAliasesSync';
import { setFilamentAliases } from '../../utils/filamentAliases';
import type { FilamentAliasGroups } from '../../utils/filamentAliases';
import { ColorSquare } from '../HexColorText';

type Kind = 'colors' | 'presets';

const inputClass =
  'min-h-[44px] md:min-h-9 px-2 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none';

const OTHER = '__other__';

// The rest of Settings saves itself this long after the last change.
const SAVE_DELAY_MS = 500;

function cleanMember(kind: Kind, raw: string): string | null {
  const text = raw.trim();
  if (kind === 'colors') {
    const hex = text.replace('#', '').toLowerCase();
    // The short form too, as the AMS colour palette takes it.
    if (/^[0-9a-f]{3}$/.test(hex)) return hex.split('').map((c) => c + c).join('');
    return /^[0-9a-f]{6}$/.test(hex) ? hex : null;
  }
  return text && text.length <= 64 ? text : null;
}

// A group while it is edited, with an id of its own: keyed by its index, a
// half-typed field moved to the next group when one above was removed.
interface DraftGroup {
  id: number;
  members: string[];
}
type Draft = Record<Kind, DraftGroup[]>;

/** What is saved: the groups of two or more (one alone means nothing). */
function completeGroups(draft: Draft): FilamentAliasGroups {
  const pick = (groups: DraftGroup[]) => groups.filter((g) => g.members.length >= 2).map((g) => g.members);
  return { colors: pick(draft.colors), presets: pick(draft.presets) };
}

interface Suggestion {
  value: string;
  label: string;
}

function GroupEditor({
  kind,
  group,
  suggestions,
  names,
  disabled,
  onChange,
  onRemove,
}: {
  kind: Kind;
  group: string[];
  suggestions: Suggestion[];
  names: Map<string, string>;
  disabled: boolean;
  onChange: (group: string[]) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [typing, setTyping] = useState(false);
  // Colours are picked from a list that shows each one, not from a <select> of hex codes.
  const [picking, setPicking] = useState(false);
  const [typed, setTyped] = useState('');
  const [invalid, setInvalid] = useState(false);
  const left = suggestions.filter((s) => !group.includes(s.value));

  const add = (raw: string) => {
    const member = cleanMember(kind, raw);
    if (!member) {
      setInvalid(true);
      return;
    }
    if (!group.includes(member)) onChange([...group, member]);
    setTyped('');
    setTyping(false);
    setInvalid(false);
  };

  return (
    <div className="rounded-lg border border-bambu-dark-tertiary p-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {group.map((member) => (
          <span
            key={member}
            className="inline-flex items-center gap-1.5 max-w-full pl-2 pr-1 py-1 rounded-full bg-bambu-dark-tertiary text-sm text-white"
          >
            {kind === 'colors' && <ColorSquare hex={member} className="w-4 h-4" />}
            <span className="truncate">
              {kind === 'colors' ? `#${member.toUpperCase()}` : member}
              {kind === 'presets' && names.get(member) && (
                <span className="text-bambu-gray"> · {names.get(member)}</span>
              )}
            </span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(group.filter((m) => m !== member))}
              className="p-1.5 -my-1 rounded-full text-bambu-gray hover:text-white disabled:opacity-50"
              aria-label={t('filamentAliases.removeMember', { value: kind === 'colors' ? `#${member.toUpperCase()}` : member })}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </span>
        ))}
        <button
          type="button"
          disabled={disabled}
          onClick={onRemove}
          className="ml-auto p-2 rounded-lg text-bambu-gray hover:text-red-400 disabled:opacity-50"
          aria-label={t('filamentAliases.removeGroup')}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
      {group.length < 2 && <p className="text-xs text-amber-500">{t('filamentAliases.needsTwo')}</p>}
      {!disabled && (
        <div className="flex flex-wrap gap-2">
          {!typing && kind === 'colors' ? (
            <div className="w-full">
              <button
                type="button"
                className={`${inputClass} w-full flex items-center justify-between gap-2 text-left`}
                aria-expanded={picking}
                onClick={() => setPicking((open) => !open)}
              >
                <span>{t('filamentAliases.addColor')}</span>
                <ChevronDown className={`w-4 h-4 shrink-0 text-bambu-gray transition-transform ${picking ? 'rotate-180' : ''}`} />
              </button>
              {picking && (
                <ul
                  role="listbox"
                  aria-label={t('filamentAliases.addColor')}
                  className="mt-1 max-h-72 overflow-y-auto rounded-lg border border-bambu-dark-tertiary bg-bambu-dark divide-y divide-bambu-dark-tertiary"
                >
                  {left.map((s) => (
                    <li key={s.value}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={false}
                        className="w-full min-h-[44px] px-3 py-2 flex items-center gap-2.5 text-left text-sm text-white hover:bg-bambu-dark-tertiary"
                        onClick={() => {
                          setPicking(false);
                          add(s.value);
                        }}
                      >
                        <ColorSquare hex={s.value} className="w-5 h-5" />
                        <span className="min-w-0 break-words">{s.label}</span>
                      </button>
                    </li>
                  ))}
                  <li>
                    <button
                      type="button"
                      role="option"
                      aria-selected={false}
                      className="w-full min-h-[44px] px-3 py-2 text-left text-sm text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white"
                      onClick={() => {
                        setPicking(false);
                        setTyping(true);
                      }}
                    >
                      {t('filamentAliases.typeOther')}
                    </button>
                  </li>
                </ul>
              )}
            </div>
          ) : !typing ? (
            <select
              className={`${inputClass} w-full`}
              value=""
              aria-label={t(kind === 'colors' ? 'filamentAliases.addColor' : 'filamentAliases.addPreset')}
              onChange={(e) => {
                if (e.target.value === OTHER) setTyping(true);
                else if (e.target.value) add(e.target.value);
              }}
            >
              <option value="">{t(kind === 'colors' ? 'filamentAliases.addColor' : 'filamentAliases.addPreset')}</option>
              {left.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
              <option value={OTHER}>{t('filamentAliases.typeOther')}</option>
            </select>
          ) : (
            <>
              {kind === 'colors' && cleanMember(kind, typed) && (
                <ColorSquare hex={cleanMember(kind, typed) as string} className="w-6 h-6 self-center" />
              )}
              <input
                className={`${inputClass} flex-1 min-w-0`}
                value={typed}
                autoFocus
                placeholder={kind === 'colors' ? '#E2DF60' : 'GFG99'}
                aria-label={t(kind === 'colors' ? 'filamentAliases.addColor' : 'filamentAliases.addPreset')}
                onChange={(e) => {
                  setTyped(e.target.value);
                  setInvalid(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    add(typed);
                  }
                }}
              />
              <Button type="button" size="sm" onClick={() => add(typed)}>
                {t('filamentAliases.add')}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setTyping(false)}>
                {t('common.cancel')}
              </Button>
            </>
          )}
          {invalid && (
            <p className="w-full text-xs text-red-400">
              {t(kind === 'colors' ? 'filamentAliases.invalidColor' : 'filamentAliases.invalidPreset')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Fork (filament aliases): colours and filament profiles that count as the
 * same in the queue's matching, in Settings → Filament. Saved as a whole, by
 * itself a moment after a change like the rest of Settings, so nothing is lost
 * by leaving the page; a group of one is never sent (it says so).
 */
export function FilamentAliasesCard() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const canEdit = hasPermission('settings:update');
  const { data } = useQuery({ queryKey: FILAMENT_ALIASES_QUERY_KEY, queryFn: api.getFilamentAliases });
  const [draft, setDraft] = useState<Draft | null>(null);
  const nextId = useRef(0);
  const toGroups = (groups: string[][]): DraftGroup[] => groups.map((members) => ({ id: nextId.current++, members }));

  useEffect(() => {
    if (data && draft === null) setDraft({ colors: toGroups(data.colors), presets: toGroups(data.presets) });
  }, [data, draft]);

  const place = (where: string[]) => where.map((w) => (w === 'queue' ? t('filamentAliases.queue') : w)).join(', ');
  const colorSuggestions = useMemo<Suggestion[]>(
    () =>
      (data?.seen_colors ?? []).map((c) => ({
        value: c.color,
        label: [`#${c.color.toUpperCase()}`, c.types.join('/'), place(c.where)].filter(Boolean).join(' · '),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, t],
  );
  const presetSuggestions = useMemo<Suggestion[]>(
    () =>
      (data?.seen_presets ?? []).map((p) => ({
        value: p.preset,
        label: [p.preset, p.names.join(', '), p.types.join('/'), place(p.where)].filter(Boolean).join(' · '),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, t],
  );
  const presetNames = useMemo(
    () => new Map((data?.seen_presets ?? []).filter((p) => p.names.length).map((p) => [p.preset, p.names[0]])),
    [data],
  );

  const saved = data ? JSON.stringify({ colors: data.colors, presets: data.presets }) : '';
  const wanted = draft ? completeGroups(draft) : null;
  const wantedKey = wanted ? JSON.stringify(wanted) : '';
  const dirty = wanted !== null && wantedKey !== saved;

  const mutation = useMutation({
    mutationFn: (groups: FilamentAliasGroups) => api.setFilamentAliases(groups),
    // The draft is left as it is: it may hold a group still being filled,
    // which the saved value leaves out.
    onSuccess: (result: FilamentAliases) => {
      queryClient.setQueryData(FILAMENT_ALIASES_QUERY_KEY, result);
      setFilamentAliases(result);
      queryClient.invalidateQueries({ queryKey: ['queue'] });
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  // Save a moment after the last change; on leaving the page at once.
  const pendingRef = useRef<FilamentAliasGroups | null>(null);
  const mutateRef = useRef(mutation.mutate);
  mutateRef.current = mutation.mutate;
  useEffect(() => {
    if (!canEdit || !dirty || !wanted || mutation.isPending || mutation.isError) {
      pendingRef.current = null;
      return;
    }
    pendingRef.current = wanted;
    const timer = window.setTimeout(() => {
      pendingRef.current = null;
      mutateRef.current(wanted);
    }, SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
    // wanted is keyed by wantedKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit, dirty, wantedKey, mutation.isPending, mutation.isError]);
  useEffect(
    () => () => {
      if (pendingRef.current) mutateRef.current(pendingRef.current);
    },
    [],
  );

  const update = (kind: Kind, groups: DraftGroup[]) => {
    // A failed save is tried again on the next change.
    if (mutation.isError) mutation.reset();
    setDraft((d) => (d ? { ...d, [kind]: groups } : d));
  };

  const section = (kind: Kind, suggestions: Suggestion[]) => {
    const groups = draft?.[kind] ?? [];
    return (
      <div className="space-y-2">
        <div>
          <p className="text-white">{t(kind === 'colors' ? 'filamentAliases.colors' : 'filamentAliases.presets')}</p>
          <p className="text-sm text-bambu-gray">
            {t(kind === 'colors' ? 'filamentAliases.colorsHint' : 'filamentAliases.presetsHint')}
          </p>
        </div>
        {groups.length === 0 && <p className="text-sm text-bambu-gray italic">{t('filamentAliases.none')}</p>}
        {groups.map((group) => (
          <GroupEditor
            key={group.id}
            kind={kind}
            group={group.members}
            suggestions={suggestions}
            names={presetNames}
            disabled={!canEdit}
            onChange={(next) => update(kind, groups.map((g) => (g.id === group.id ? { ...g, members: next } : g)))}
            onRemove={() => update(kind, groups.filter((g) => g.id !== group.id))}
          />
        ))}
        {canEdit && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => update(kind, [...groups, { id: nextId.current++, members: [] }])}
          >
            <Plus className="w-4 h-4" />
            {t(kind === 'colors' ? 'filamentAliases.addColorGroup' : 'filamentAliases.addPresetGroup')}
          </Button>
        )}
      </div>
    );
  };

  return (
    <Card id="card-filament-aliases">
      <CardHeader>
        <h2 className="text-lg font-semibold text-white">{t('filamentAliases.title')}</h2>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-bambu-gray">{t('filamentAliases.description')}</p>
        {section('presets', presetSuggestions)}
        {section('colors', colorSuggestions)}
        {canEdit && (mutation.isPending || mutation.isSuccess || mutation.isError) && (
          <p
            data-testid="filament-aliases-status"
            className={`flex items-center justify-end gap-1.5 text-xs ${mutation.isError ? 'text-red-400' : 'text-bambu-gray'}`}
            aria-live="polite"
          >
            {mutation.isPending ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {t('filamentAliases.saving')}
              </>
            ) : mutation.isError ? (
              t('filamentAliases.saveFailed')
            ) : dirty ? null : (
              <>
                <Check className="w-3.5 h-3.5 text-bambu-green" />
                {t('filamentAliases.saved')}
              </>
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
