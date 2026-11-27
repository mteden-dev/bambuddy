import type { TFunction } from 'i18next';
import { Layers, Printer, Trash2, Unlink } from 'lucide-react';
import type { GroupRow } from '../../pages/fileManager/variantGroups';
import type { ContextMenuItem } from '../ContextMenu';
import type { VariantGroupActions } from './useVariantGroupActions';

// The menu of a version group (#3628): the grid card's kebab and, on a phone,
// the list row's single menu button (fork).
export function groupMenuItems(row: GroupRow, actions: VariantGroupActions, t: TFunction): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (actions.hasPrintable(row)) {
    items.push({
      label: t('fileManager.variants.print'),
      icon: <Printer className="w-4 h-4 text-bambu-green" />,
      onClick: () => actions.print(row),
      disabled: !actions.canPrint(row),
      title: !actions.canPrint(row) ? t('fileManager.noPermissionAddToQueue') : undefined,
    });
    items.push({
      label: t('fileManager.variants.printOn'),
      icon: <Printer className="w-4 h-4" />,
      onClick: () => actions.printOn(row),
      disabled: !actions.canPrint(row),
      title: !actions.canPrint(row) ? t('fileManager.noPermissionAddToQueue') : undefined,
    });
  }
  items.push(
    // Fork: a new printer's version joins without ungrouping.
    {
      label: t('fileManager.variants.addVersion'),
      icon: <Layers className="w-4 h-4" />,
      onClick: () => actions.addVersion(row),
      disabled: !actions.canAddVersion(row),
      title: !actions.canAddVersion(row) ? t('fileManager.variants.noPermissionUngroup') : undefined,
    },
    {
      label: t('fileManager.variants.ungroup'),
      icon: <Unlink className="w-4 h-4" />,
      onClick: () => actions.ungroup(row),
      disabled: !actions.canUngroup(row),
      title: !actions.canUngroup(row) ? t('fileManager.variants.noPermissionUngroup') : undefined,
    },
    {
      label: t('fileManager.variants.deleteGroup'),
      icon: <Trash2 className="w-4 h-4" />,
      onClick: () => actions.deleteFiles(row),
      danger: true,
      disabled: !actions.canDeleteFiles(row),
      title: !actions.canDeleteFiles(row) ? t('fileManager.variants.noPermissionDeleteGroup') : undefined,
    },
  );
  return items;
}
