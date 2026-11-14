import { useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Eye, EyeOff, GripVertical, Loader2, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { applySavedUiSettings, useUiSettings } from '../hooks/useUiSettings';
import {
  AMS_COLOR_NAME_MAX_LEN,
  AMS_COLOR_PALETTE_MAX,
  DEFAULT_AMS_COLOR_PALETTE,
  moveItem,
  normalizeHex,
  parseAmsColorPalette,
  serializeAmsColorPalette,
  type PaletteColor,
} from '../utils/amsColorPalette';

interface AmsColorPaletteProps {
  /** The colour set in the form, six hex digits or empty. */
  selectedHex: string;
  /** Called with the colour's name and hex when a swatch is clicked. */
  onPick: (name: string, hex: string) => void;
  /** Name and hex a new palette colour starts from (the form's current colour). */
  suggestedName?: string;
}

// A palette row while it is being edited: the hex is the text as typed, so a
// half-typed value is kept instead of snapping back.
interface DraftColor {
  key: number;
  name: string;
  hex: string;
  hidden: boolean;
}

/**
 * The AMS slot picker's quick colours (the ams_color_palette setting).
 *
 * Shows the visible colours, with the hidden ones behind a "more colours"
 * button, and the hovered colour's name and hex under them so a value can be
 * matched to the slicer's exactly. Users who may change settings can edit
 * the palette: add, remove, rename, recolour, hide and reorder.
 */
export function AmsColorPalette({ selectedHex, onPick, suggestedName }: AmsColorPaletteProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('settings:update');
  const queryClient = useQueryClient();
  const { data: uiSettings } = useUiSettings();
  const palette = useMemo(() => parseAmsColorPalette(uiSettings?.ams_color_palette), [uiSettings?.ams_color_palette]);
  // Editing starts from the stored palette: until it has loaded, a save would
  // replace it with the defaults shown in the meantime.
  const paletteLoaded = uiSettings !== undefined;

  const [showHidden, setShowHidden] = useState(false);
  const [hovered, setHovered] = useState<PaletteColor | null>(null);
  const [draft, setDraft] = useState<DraftColor[] | null>(null);
  const nextKey = useRef(0);
  const dragFrom = useRef<number | null>(null);

  const visible = palette.filter((c) => !c.hidden);
  const hidden = palette.filter((c) => c.hidden);

  const saveMutation = useMutation({
    mutationFn: (value: string) => api.updateSettings({ ams_color_palette: value }),
    onSuccess: (saved) => {
      applySavedUiSettings(queryClient, { ams_color_palette: saved.ams_color_palette });
      setDraft(null);
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const toDraft = (colors: readonly PaletteColor[]): DraftColor[] =>
    colors.map((c) => ({ key: nextKey.current++, name: c.name, hex: c.hex, hidden: !!c.hidden }));

  const updateRow = (index: number, patch: Partial<DraftColor>) =>
    setDraft((rows) => rows && rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const rowErrors = (row: DraftColor) => ({
    name: !row.name.trim() || row.name.trim().length > AMS_COLOR_NAME_MAX_LEN,
    hex: normalizeHex(row.hex) === null,
  });
  const draftInvalid = !!draft?.some((row) => {
    const errors = rowErrors(row);
    return errors.name || errors.hex;
  });

  const save = () => {
    if (!draft || draftInvalid) return;
    saveMutation.mutate(
      serializeAmsColorPalette(
        draft.map((row) => ({ name: row.name.trim(), hex: normalizeHex(row.hex)!, hidden: row.hidden })),
      ),
    );
  };

  const swatch = (color: PaletteColor, index: number) => (
    <button
      key={`${index}-${color.hex}-${color.name}`}
      type="button"
      onClick={() => onPick(color.name, color.hex)}
      onMouseEnter={() => setHovered(color)}
      onFocus={() => setHovered(color)}
      onBlur={() => setHovered(null)}
      className={`w-7 h-7 rounded-md border-2 transition-all ${
        selectedHex === color.hex ? 'border-bambu-green scale-110' : 'border-white/20 hover:border-white/40'
      }`}
      style={{ backgroundColor: `#${color.hex}` }}
      title={color.name}
      aria-label={`${color.name} #${color.hex}`}
    />
  );

  if (draft) {
    return (
      <div className="mb-2 rounded-lg border border-bambu-dark-tertiary p-2 space-y-2">
        <p className="text-xs text-bambu-gray">{t('configureAmsSlot.palette.editHint')}</p>
        <div className="max-h-64 overflow-y-auto space-y-1 pr-1">
          {draft.length === 0 && (
            <p className="text-xs text-bambu-gray italic py-2 text-center">{t('configureAmsSlot.palette.empty')}</p>
          )}
          {draft.map((row, index) => {
            const errors = rowErrors(row);
            const hex = normalizeHex(row.hex);
            return (
              <div
                key={row.key}
                className={`flex items-center gap-1 ${row.hidden ? 'opacity-60' : ''}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom.current !== null) setDraft((rows) => rows && moveItem(rows, dragFrom.current!, index));
                  dragFrom.current = null;
                }}
              >
                <span
                  draggable
                  onDragStart={() => {
                    dragFrom.current = index;
                  }}
                  className="cursor-grab text-bambu-gray hover:text-white"
                  title={t('configureAmsSlot.palette.drag')}
                >
                  <GripVertical className="w-4 h-4" />
                </span>
                <input
                  type="color"
                  value={`#${hex ?? '000000'}`}
                  onChange={(e) => updateRow(index, { hex: e.target.value.slice(1).toUpperCase() })}
                  className="w-7 h-7 shrink-0 cursor-pointer rounded border border-white/20 bg-transparent p-0"
                  aria-label={t('configureAmsSlot.palette.pickColor', { name: row.name })}
                />
                <input
                  type="text"
                  value={row.name}
                  maxLength={AMS_COLOR_NAME_MAX_LEN}
                  onChange={(e) => updateRow(index, { name: e.target.value })}
                  placeholder={t('configureAmsSlot.palette.namePlaceholder')}
                  aria-label={t('configureAmsSlot.palette.namePlaceholder')}
                  className={`min-w-0 flex-1 px-2 py-1 bg-bambu-dark border rounded text-white text-xs focus:outline-none focus:border-bambu-green ${
                    errors.name ? 'border-red-500' : 'border-bambu-dark-tertiary'
                  }`}
                />
                <input
                  type="text"
                  value={row.hex}
                  onChange={(e) => updateRow(index, { hex: e.target.value })}
                  onBlur={() => hex && updateRow(index, { hex })}
                  placeholder="RRGGBB"
                  aria-label={t('configureAmsSlot.palette.hex')}
                  className={`w-[4.75rem] shrink-0 px-2 py-1 bg-bambu-dark border rounded text-white text-xs font-mono uppercase focus:outline-none focus:border-bambu-green ${
                    errors.hex ? 'border-red-500' : 'border-bambu-dark-tertiary'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => setDraft((rows) => rows && moveItem(rows, index, index - 1))}
                  disabled={index === 0}
                  className="p-0.5 text-bambu-gray hover:text-white disabled:opacity-30"
                  title={t('configureAmsSlot.palette.moveUp')}
                  aria-label={`${t('configureAmsSlot.palette.moveUp')}: ${row.name}`}
                >
                  <ChevronUp className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setDraft((rows) => rows && moveItem(rows, index, index + 1))}
                  disabled={index === draft.length - 1}
                  className="p-0.5 text-bambu-gray hover:text-white disabled:opacity-30"
                  title={t('configureAmsSlot.palette.moveDown')}
                  aria-label={`${t('configureAmsSlot.palette.moveDown')}: ${row.name}`}
                >
                  <ChevronDown className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => updateRow(index, { hidden: !row.hidden })}
                  className="p-0.5 text-bambu-gray hover:text-white"
                  title={row.hidden ? t('configureAmsSlot.palette.show') : t('configureAmsSlot.palette.hide')}
                  aria-label={`${row.hidden ? t('configureAmsSlot.palette.show') : t('configureAmsSlot.palette.hide')}: ${row.name}`}
                >
                  {row.hidden ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => setDraft((rows) => rows && rows.filter((_, i) => i !== index))}
                  className="p-0.5 text-bambu-gray hover:text-red-400"
                  title={t('configureAmsSlot.palette.remove')}
                  aria-label={`${t('configureAmsSlot.palette.remove')}: ${row.name}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              setDraft((rows) => rows && [
                ...rows,
                {
                  key: nextKey.current++,
                  name: suggestedName?.trim().slice(0, AMS_COLOR_NAME_MAX_LEN) || t('configureAmsSlot.palette.newColor'),
                  hex: selectedHex || 'FFFFFF',
                  hidden: false,
                },
              ])
            }
            disabled={draft.length >= AMS_COLOR_PALETTE_MAX}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-bambu-dark-tertiary text-white hover:bg-bambu-dark-tertiary/70 disabled:opacity-40"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('configureAmsSlot.palette.add')}
          </button>
          <button
            type="button"
            onClick={() => setDraft(toDraft(DEFAULT_AMS_COLOR_PALETTE))}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded text-bambu-gray hover:text-white"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            {t('configureAmsSlot.palette.restoreDefaults')}
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setDraft(null)}
            disabled={saveMutation.isPending}
            className="px-2 py-1 text-xs rounded text-bambu-gray hover:text-white"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={draftInvalid || saveMutation.isPending}
            className="flex items-center gap-1 px-3 py-1 text-xs rounded bg-bambu-green text-white hover:bg-bambu-green/80 disabled:opacity-40"
          >
            {saveMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {t('configureAmsSlot.palette.save')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-2">
      <div className="flex flex-wrap gap-1.5" onMouseLeave={() => setHovered(null)}>
        {visible.map(swatch)}
        {showHidden && hidden.map((color, i) => swatch(color, visible.length + i))}
        {hidden.length > 0 && (
          <button
            type="button"
            onClick={() => setShowHidden(!showHidden)}
            className="w-7 h-7 rounded-md border-2 border-white/20 hover:border-white/40 flex items-center justify-center text-white/60 hover:text-white/80 transition-all text-xs"
            title={showHidden ? t('configureAmsSlot.showLessColors') : t('configureAmsSlot.showMoreColors')}
          >
            {showHidden ? '−' : '+'}
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              setHovered(null);
              setDraft(toDraft(palette));
            }}
            disabled={!paletteLoaded}
            className="w-7 h-7 rounded-md border-2 border-dashed disabled:opacity-40 border-white/20 hover:border-white/40 flex items-center justify-center text-white/60 hover:text-white/80 transition-all"
            title={t('configureAmsSlot.palette.edit')}
            aria-label={t('configureAmsSlot.palette.edit')}
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {/* The hovered colour, so its exact hex can be matched to the slicer's
          without waiting on the browser's title tooltip. Height is reserved so
          the form does not jump while the pointer moves across the swatches. */}
      <p className="text-xs text-bambu-gray mt-1 h-4">
        {hovered && (
          <>
            {hovered.name} <span className="font-mono text-white/80">#{hovered.hex}</span>
          </>
        )}
      </p>
    </div>
  );
}
