import { useTranslation } from 'react-i18next';
import { Printer, Tag } from 'lucide-react';

const MAX_SHOWN = 3;

/**
 * A file's tags stacked under the type badge on its thumbnail (fork). Printer
 * tags, the ones some printer carries and that route its queue jobs
 * (utils/printerTags.ts), come first and are filled. A click filters the file
 * list by the tag, like the chips used to below the card's details.
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
  if (tags.length === 0) return null;
  const isRouting = (id: number) => routingTagIds?.has(id) ?? false;
  const sorted = [...tags].sort(
    (a, b) =>
      Number(isRouting(b.id)) - Number(isRouting(a.id)) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
  const shown = sorted.slice(0, MAX_SHOWN);
  const rest = sorted.slice(MAX_SHOWN);

  return (
    <div className="flex flex-col items-end gap-1 max-w-full" data-testid="thumbnail-tags">
      {shown.map((tg) => {
        const routing = isRouting(tg.id);
        const Icon = routing ? Printer : Tag;
        return (
          <button
            key={tg.id}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onTagClick?.(tg.id);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium max-w-full shadow-sm transition-colors ${
              routing
                ? 'bg-bambu-green/90 text-white hover:bg-bambu-green'
                : 'bg-black/60 text-white hover:bg-black/75'
            }`}
            title={routing ? `${tg.name} — ${t('printerTags.fileChipHint')}` : tg.name}
          >
            <Icon className="w-2.5 h-2.5 flex-shrink-0" />
            <span className="truncate">{tg.name}</span>
          </button>
        );
      })}
      {rest.length > 0 && (
        <span
          className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-black/60 text-white shadow-sm"
          title={rest.map((tg) => tg.name).join(', ')}
        >
          +{rest.length}
        </span>
      )}
    </div>
  );
}
