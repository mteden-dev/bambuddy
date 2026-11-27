import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarClock, ChevronDown, ChevronRight, Layers, MoreVertical, Tag as TagIcon, User } from 'lucide-react';
import { ContextMenu } from '../ContextMenu';
import { groupMenuItems } from './groupMenuItems';
import { TOUCH_BUTTON, usePhoneWidth } from '../../pages/fileManager/useCoarsePointer';
import { api } from '../../api/client';
import { formatDate } from '../../utils/date';
import { formatFileSize } from '../../utils/file';
import type { GroupRow } from '../../pages/fileManager/variantGroups';
import { VariantGroupActionStrip } from './VariantGroupActionStrip';
import { VariantMemberLine } from './VariantMemberLine';
import { VariantSelectionBox } from './VariantSelectionBox';
import { groupSelection } from '../../pages/fileManager/variantSelection';
import { dragSourceProps, type VariantGroupViewProps } from './variantTypes';

// A version group as one expandable row of the list view (#3628). It lines up
// with the file rows beside it (`gridClassName` is theirs); expanding it
// shows the versions indented underneath.
export function VariantGroupListRow({
  row,
  gridClassName,
  typeBadgeClass,
  selectedIds,
  highlightedFileId,
  thumbnailVersions,
  showModified,
  authEnabled,
  onToggleSelect,
  onTagClick,
  memberActions,
  groupActions,
  groupDrag,
}: {
  row: GroupRow;
  gridClassName: string;
  /** Colours of a file type's badge, the one plain rows use. */
  typeBadgeClass: (fileType: string) => string;
} & VariantGroupViewProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();

  const first = row.thumbnailFile;
  const { count: selectedCount, total: selectableCount } = groupSelection(row, selectedIds);
  const highlighted = highlightedFileId !== null && row.members.some((m) => m.id === highlightedFileId);
  const version = thumbnailVersions[first.id];
  const thumbUrl = api.getLibraryFileThumbnailUrl(first.id);
  const owners = [...new Set(row.members.map((m) => m.created_by_username).filter((u): u is string => !!u))];
  const types = [...new Set(row.members.map((m) => m.file_type))];
  const tags = new Map<number, { id: number; name: string }>();
  for (const m of row.members) for (const tg of m.tags ?? []) tags.set(tg.id, tg);
  const totalSize = row.members.reduce((sum, m) => sum + m.file_size, 0);
  const printed = row.members.reduce((sum, m) => sum + m.print_count, 0);
  const phone = usePhoneWidth();
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const thumbnail = (
    <div className="w-10 h-10 rounded bg-bambu-dark flex-shrink-0 overflow-hidden flex items-center justify-center">
      {first.thumbnail_path ? (
        <img
          src={`${thumbUrl}${version ? (thumbUrl.includes('?') ? '&' : '?') + `v=${version}` : ''}`}
          loading="lazy"
          alt=""
          className="w-full h-full object-cover"
        />
      ) : (
        <Layers className="w-5 h-5 text-bambu-gray/50" />
      )}
    </div>
  );
  const versionsPanel = expanded && (
    <div
      id={panelId}
      role="group"
      aria-label={t('fileManager.variants.versionsHeading')}
      // Fork: as wide as the screen and pinned to its left edge on a phone,
      // so each version's menu button is on screen, not past the wide row.
      className="pl-14 pr-4 py-1 border-t border-bambu-dark-tertiary bg-bambu-dark/30 max-sm:sticky max-sm:left-0 max-sm:pl-4 max-sm:max-w-[calc(100vw-2rem)]"
    >
      {row.members.map((m) => (
        <VariantMemberLine
          key={m.id}
          file={m}
          group={row}
          memberActions={memberActions}
          groupActions={groupActions}
          highlighted={highlightedFileId === m.id}
        />
      ))}
    </div>
  );

  // Fork: on a phone the row is name, versions and one menu button; the full
  // row's group actions sit some 1000px to the right of a 375px screen.
  if (phone) {
    return (
      <div className="border-b border-bambu-dark-tertiary last:border-b-0">
        <div
          data-testid="variant-group-list-row"
          data-variant-group-id={row.id}
          data-file-id={first.id}
          data-member-ids={row.members.map((m) => m.id).join(' ')}
          style={highlighted ? { outline: '2px solid #facc15', outlineOffset: '-2px' } : undefined}
          className={`sticky left-0 max-w-[calc(100vw-2rem)] flex items-center gap-3 px-4 py-2 cursor-pointer ${
            selectedCount > 0 ? 'bg-bambu-green/10' : ''
          }`}
          onClick={() => onToggleSelect(row)}
          {...dragSourceProps(row, groupDrag)}
        >
          <VariantSelectionBox
            selectedCount={selectedCount}
            total={selectableCount}
            label={t('fileManager.variants.selectGroup', { name: row.name })}
            onToggle={() => onToggleSelect(row)}
          />
          {thumbnail}
          <div className="min-w-0 flex-1">
            <div className="text-sm text-white truncate" title={row.name}>{row.name}</div>
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={panelId}
              aria-label={`${expanded ? t('fileManager.variants.hideVersions') : t('fileManager.variants.showVersions')}: ${row.name}`}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
              className="inline-flex items-center gap-1 text-xs text-bambu-green any-pointer-coarse:min-h-[44px] pr-2"
            >
              {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              <Layers className="w-3 h-3" aria-hidden="true" />
              {t('fileManager.variants.badge', { count: row.members.length })}
            </button>
          </div>
          <button
            type="button"
            aria-label={t('fileManager.variants.groupActions', { name: row.name })}
            aria-haspopup="menu"
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              setMenuAnchor({ x: rect.left, y: rect.bottom + 4 });
            }}
            className={`p-1.5 rounded flex-shrink-0 hover:bg-bambu-dark-tertiary ${TOUCH_BUTTON}`}
          >
            <MoreVertical className="w-4 h-4 text-bambu-gray" />
          </button>
          {menuAnchor && (
            <ContextMenu
              x={menuAnchor.x}
              y={menuAnchor.y}
              items={groupMenuItems(row, groupActions, t)}
              onClose={() => setMenuAnchor(null)}
            />
          )}
        </div>
        {versionsPanel}
      </div>
    );
  }

  return (
    // One block as wide as the row's grid, so the open panel's background and
    // border run as far as the row's when the list scrolls sideways.
    <div className="min-w-min border-b border-bambu-dark-tertiary last:border-b-0">
      <div
        data-testid="variant-group-list-row"
        data-variant-group-id={row.id}
        data-file-id={first.id}
        data-member-ids={row.members.map((m) => m.id).join(' ')}
        style={highlighted ? { outline: '2px solid #facc15', outlineOffset: '-2px' } : undefined}
        className={`grid ${gridClassName} min-w-min gap-4 px-4 py-3 items-center cursor-pointer hover:bg-bambu-dark/50 transition-colors ${
          selectedCount > 0 ? 'bg-bambu-green/10' : ''
        }`}
        onClick={() => onToggleSelect(row)}
        {...dragSourceProps(row, groupDrag)}
      >
        <VariantSelectionBox
          selectedCount={selectedCount}
          total={selectableCount}
          label={t('fileManager.variants.selectGroup', { name: row.name })}
          onToggle={() => onToggleSelect(row)}
        />
        <div className="flex items-center gap-3 min-w-0">
          {thumbnail}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={panelId}
                aria-label={`${expanded ? t('fileManager.variants.hideVersions') : t('fileManager.variants.showVersions')}: ${row.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded((v) => !v);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
                className={`flex-shrink-0 p-0.5 rounded text-bambu-gray hover:text-white ${TOUCH_BUTTON}`}
              >
                {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
              <span className="text-sm text-white truncate" title={row.name}>{row.name}</span>
              <span className="flex-shrink-0 inline-flex items-center gap-1 text-xs text-bambu-green">
                <Layers className="w-3 h-3" aria-hidden="true" />
                {t('fileManager.variants.badge', { count: row.members.length })}
              </span>
            </div>
            {showModified && (
              <div className="text-xs text-bambu-gray flex items-center gap-1 mt-0.5" title={t('fileManager.lastModified')}>
                <CalendarClock className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{formatDate(row.newest.fs_modified_at ?? row.newest.created_at)}</span>
              </div>
            )}
          </div>
        </div>
        {authEnabled && (
          <div className="text-sm text-bambu-gray flex items-center gap-1 min-w-0">
            {owners.length === 1 ? (
              <>
                <User className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{owners[0]}</span>
              </>
            ) : (
              '-'
            )}
          </div>
        )}
        <div>
          <span
            className={`text-xs px-1.5 py-0.5 rounded font-medium ${
              types.length === 1 ? typeBadgeClass(types[0]) : 'bg-bambu-gray/20 text-bambu-gray'
            }`}
          >
            {types.length === 1 ? types[0].toUpperCase() : t('fileManager.variants.mixedTypes')}
          </span>
        </div>
        <div className="text-sm text-bambu-gray">{formatFileSize(totalSize)}</div>
        <div className="text-sm text-bambu-gray">{printed > 0 ? `${printed}x` : '-'}</div>
        <div className="min-w-0" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          {tags.size === 0 ? (
            <span className="text-xs text-bambu-gray/50">-</span>
          ) : (
            <div className="flex flex-wrap gap-1">
              {[...tags.values()].map((tg) => (
                <button
                  key={tg.id}
                  type="button"
                  onClick={() => onTagClick?.(tg.id)}
                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] bg-bambu-green/10 text-bambu-green hover:bg-bambu-green/20 transition-colors max-w-full"
                  title={tg.name}
                >
                  <TagIcon className="w-2.5 h-2.5 flex-shrink-0" />
                  <span className="truncate">{tg.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <VariantGroupActionStrip row={row} actions={groupActions} />
      </div>
      {versionsPanel}
    </div>
  );
}
