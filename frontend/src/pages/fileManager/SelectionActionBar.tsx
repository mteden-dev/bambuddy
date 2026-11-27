import { cloneElement, isValidElement, useState, type ReactElement, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '../../components/Button';
import { ContextMenu } from '../../components/ContextMenu';

// One action on the file selection: a toolbar button with a mouse, a bottom
// bar button or a menu entry on a touch device (fork).
export interface SelectionAction {
  key: string;
  variant: 'primary' | 'secondary' | 'danger';
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}

// On the bar itself; everything else is behind "More".
const ON_BAR = new Set(['print', 'move', 'delete']);

// The icon without the toolbar's spacing, for a menu entry.
function bareIcon(icon: ReactNode): ReactNode {
  if (!isValidElement(icon)) return icon;
  const element = icon as ReactElement<{ className?: string }>;
  return cloneElement(element, { className: (element.props.className ?? '').replace('sm:mr-1', '').trim() });
}

/**
 * Fork: the selection's actions on a touch device, pinned to the bottom of
 * the screen where a thumb reaches them, with their labels shown (the Print
 * label says how the selection splits into jobs) and the rest in a menu.
 */
export function SelectionActionBar({ actions, t }: { actions: SelectionAction[]; t: TFunction }) {
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const onBar = actions.filter((a) => ON_BAR.has(a.key));
  const inMenu = actions.filter((a) => !ON_BAR.has(a.key));

  return (
    <div
      data-testid="selection-action-bar"
      className="sticky bottom-0 z-20 -mx-4 md:-mx-8 -mb-4 md:-mb-8 mt-3 flex items-center gap-2 border-t border-bambu-dark-tertiary bg-bambu-dark-secondary px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
    >
      {onBar.map((action) => (
        <Button
          key={action.key}
          variant={action.variant}
          size="sm"
          onClick={action.onClick}
          disabled={action.disabled}
          title={action.title}
          className={`min-w-0 ${action.key === 'print' ? 'flex-1' : 'flex-shrink-0'}`}
        >
          {bareIcon(action.icon)}
          <span className="truncate">{action.label}</span>
        </Button>
      ))}
      {inMenu.length > 0 && (
        <Button
          variant="secondary"
          size="sm"
          aria-haspopup="menu"
          aria-label={t('fileManager.selectionMore')}
          className="flex-shrink-0 ml-auto min-w-[44px]"
          onClick={(e) => {
            if (menuAnchor) {
              setMenuAnchor(null);
              return;
            }
            const rect = e.currentTarget.getBoundingClientRect();
            setMenuAnchor({ x: rect.left, y: rect.top - 4 });
          }}
        >
          <MoreHorizontal className="w-4 h-4" />
        </Button>
      )}
      {menuAnchor && (
        <ContextMenu
          x={menuAnchor.x}
          y={menuAnchor.y}
          onClose={() => setMenuAnchor(null)}
          items={inMenu.map((action) => ({
            label: action.label,
            icon: bareIcon(action.icon),
            onClick: action.onClick,
            disabled: action.disabled,
            title: action.title,
            danger: action.variant === 'danger',
          }))}
        />
      )}
    </div>
  );
}
