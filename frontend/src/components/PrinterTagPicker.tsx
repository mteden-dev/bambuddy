import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, Tag, X } from 'lucide-react';

import { api } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { libraryTagsQueryKey } from '../utils/libraryTagsQuery';

interface PrinterTagPickerProps {
  /** Selected tag ids. */
  value: number[];
  onChange: (ids: number[]) => void;
  /** Tags that can be picked, id and name. */
  options: { id: number; name: string }[];
  /** Offer to create a tag that is not in ``options`` (adds it to the library catalog). */
  allowCreate?: boolean;
  disabled?: boolean;
  /** For tests and labels. */
  id?: string;
}

/**
 * Chips of the chosen printer tags plus an "Add tag" button that opens a
 * searchable list (fork). Used in the printer's edit dialog and the print
 * dialog's "Any <model>" mode.
 */
export function PrinterTagPicker({ value, onChange, options, allowCreate, disabled, id }: PrinterTagPickerProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // On a touch screen the search field is not focused on open: the keyboard
  // would come up over the list it is meant to search.
  const touch = typeof window !== 'undefined' && !!window.matchMedia?.('(any-pointer: coarse)').matches;

  const names = useMemo(() => new Map(options.map((o) => [o.id, o.name])), [options]);
  const q = query.trim().toLowerCase();
  const choices = useMemo(
    () =>
      options
        .filter((o) => !value.includes(o.id) && (!q || o.name.toLowerCase().includes(q)))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [options, value, q],
  );
  const exact = options.some((o) => o.name.trim().toLowerCase() === q);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    // The picker sits in a scrolling dialog: bring the list into view, and
    // again when the on-screen keyboard shrinks the viewport.
    const reveal = () => dropdownRef.current?.scrollIntoView?.({ block: 'nearest' });
    const raf = requestAnimationFrame(reveal);
    window.visualViewport?.addEventListener('resize', reveal);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('mousedown', onDown);
      window.visualViewport?.removeEventListener('resize', reveal);
    };
  }, [open]);

  const create = useMutation({
    mutationFn: (name: string) => api.createLibraryTag(name),
    onSuccess: (tag) => {
      queryClient.invalidateQueries({ queryKey: libraryTagsQueryKey });
      onChange([...value, tag.id]);
      setQuery('');
      setOpen(false);
    },
    onError: (err: Error) => showToast(err.message || t('printerTags.saveFailed'), 'error'),
  });

  const pick = (tagId: number) => {
    onChange([...value, tagId]);
    setQuery('');
    setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative" id={id}>
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((tagId) => (
          <span
            key={tagId}
            className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs bg-bambu-green/15 text-bambu-green"
          >
            <Tag className="w-3 h-3 flex-shrink-0" />
            <span className="truncate max-w-[10rem]">{names.get(tagId) ?? `#${tagId}`}</span>
            {!disabled && (
              <button
                type="button"
                onClick={() => onChange(value.filter((v) => v !== tagId))}
                className="p-0.5 any-pointer-coarse:min-w-[44px] any-pointer-coarse:min-h-[44px] inline-flex items-center justify-center rounded-full hover:bg-bambu-green/25"
                aria-label={t('printerTags.remove', { name: names.get(tagId) ?? tagId })}
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </span>
        ))}
        {!disabled && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-1 px-2 py-0.5 any-pointer-coarse:min-h-[44px] any-pointer-coarse:px-3 rounded-full text-xs border border-dashed border-bambu-dark-tertiary text-bambu-gray hover:border-bambu-green hover:text-bambu-green"
          >
            <Plus className="w-3 h-3" />
            {t('printerTags.add')}
          </button>
        )}
        {disabled && value.length === 0 && <span className="text-xs text-bambu-gray">{t('printerTags.none')}</span>}
      </div>
      {open && (
        <div ref={dropdownRef} className="absolute z-20 mt-1 w-64 max-w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-lg">
          <input
            autoFocus={!touch}
            type="text"
            value={query}
            maxLength={64}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setOpen(false);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (choices.length > 0) pick(choices[0].id);
                else if (allowCreate && q && !exact) create.mutate(query.trim());
              }
            }}
            placeholder={allowCreate ? t('printerTags.searchOrCreate') : t('printerTags.search')}
            className="w-full px-3 py-2 bg-bambu-dark border-b border-bambu-dark-tertiary rounded-t-lg text-sm text-white placeholder-bambu-gray focus:outline-none"
          />
          <ul className="max-h-48 overflow-y-auto py-1">
            {choices.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => pick(o.id)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 any-pointer-coarse:min-h-[44px] text-left text-sm text-white hover:bg-bambu-dark-tertiary/50"
                >
                  <Tag className="w-3.5 h-3.5 text-bambu-gray flex-shrink-0" />
                  <span className="truncate">{o.name}</span>
                </button>
              </li>
            ))}
            {allowCreate && q && !exact && (
              <li>
                <button
                  type="button"
                  onClick={() => create.mutate(query.trim())}
                  disabled={create.isPending}
                  className="w-full flex items-center gap-2 px-3 py-1.5 any-pointer-coarse:min-h-[44px] text-left text-sm text-bambu-green hover:bg-bambu-dark-tertiary/50"
                >
                  {create.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                  <span className="truncate">{t('printerTags.create', { name: query.trim() })}</span>
                </button>
              </li>
            )}
            {choices.length === 0 && !(allowCreate && q && !exact) && (
              <li className="px-3 py-2 text-xs text-bambu-gray">
                {options.length === 0 ? t('printerTags.emptyCatalog') : t('printerTags.noMatches')}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Read-only chips, for cards and queue rows. */
export function PrinterTagChips({
  tagIds,
  names,
  className = '',
  title,
}: {
  tagIds: number[];
  names: Map<number, string>;
  className?: string;
  title?: string;
}) {
  const shown = tagIds
    .map((id) => ({ id, name: names.get(id) }))
    .filter((t): t is { id: number; name: string } => !!t.name)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  if (shown.length === 0) return null;
  return (
    <span className={`inline-flex flex-wrap items-center gap-1 ${className}`} title={title}>
      {shown.map((tg) => (
        <span
          key={tg.id}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] bg-bambu-green/10 text-bambu-green max-w-full"
        >
          <Tag className="w-2.5 h-2.5 flex-shrink-0" />
          <span className="truncate">{tg.name}</span>
        </span>
      ))}
    </span>
  );
}
