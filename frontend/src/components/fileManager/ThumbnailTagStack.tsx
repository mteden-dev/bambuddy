import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Printer, Tag } from 'lucide-react';
import { TOUCH_HIT_AREA, useCoarsePointer } from '../../pages/fileManager/useCoarsePointer';

const MAX_SHOWN = 3;

/**
 * A file's tags stacked under the type badge on its thumbnail (fork). Printer
 * tags, the ones some printer carries and that route its queue jobs
 * (utils/printerTags.ts), come first and are filled. A click filters the file
 * list by the tag, like the chips used to below the card's details. On a
 * touch device the chips only show: a 16px chip on a card whose tap selects
 * it is a mis-tap that swaps the whole view for a tag filter, which stays in
 * the filter controls. "+N" opens the rest in place.
 */
export function ThumbnailTagStack({
  tags,
  routingTagIds,
  onTagClick,
}: {
  tags: { id: number; name: string }[];
  routingTagIds?: Set<number>;
  onTagClick?: (tagId: number) => void;
}) {
  const { t } = useTranslation();
  const coarse = useCoarsePointer();
  const [showAll, setShowAll] = useState(false);
  if (tags.length === 0) return null;
  const isRouting = (id: number) => routingTagIds?.has(id) ?? false;
  const sorted = [...tags].sort(
    (a, b) =>
      Number(isRouting(b.id)) - Number(isRouting(a.id)) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
  const shown = showAll ? sorted : sorted.slice(0, MAX_SHOWN);
  const rest = sorted.slice(MAX_SHOWN);
  const clickable = !coarse && !!onTagClick;

  return (
    <div className="flex flex-col items-end gap-1 max-w-full" data-testid="thumbnail-tags">
      {shown.map((tg) => {
        const routing = isRouting(tg.id);
        const Icon = routing ? Printer : Tag;
        const className = `inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium max-w-full shadow-sm transition-colors ${
          routing ? 'bg-bambu-green/90 text-white' : 'bg-black/60 text-white'
        } ${clickable ? (routing ? 'hover:bg-bambu-green' : 'hover:bg-black/75') : ''}`;
        const title = routing ? `${tg.name} — ${t('printerTags.fileChipHint')}` : tg.name;
        const content = (
          <>
            <Icon className="w-2.5 h-2.5 flex-shrink-0" />
            <span className="truncate">{tg.name}</span>
          </>
        );
        return clickable ? (
          <button
            key={tg.id}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onTagClick?.(tg.id);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            className={className}
            title={title}
          >
            {content}
          </button>
        ) : (
          <span key={tg.id} className={className} title={title} data-testid="thumbnail-tag">
            {content}
          </span>
        );
      })}
      {rest.length > 0 && (
        <button
          type="button"
          aria-expanded={showAll}
          aria-label={showAll ? t('fileManager.tags.showFewerTags') : t('fileManager.tags.showAllTags', { count: tags.length })}
          onClick={(e) => {
            e.stopPropagation();
            setShowAll((v) => !v);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          className={`relative px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-black/60 text-white shadow-sm hover:bg-black/75 ${TOUCH_HIT_AREA}`}
        >
          {showAll ? '−' : `+${rest.length}`}
        </button>
      )}
    </div>
  );
}
