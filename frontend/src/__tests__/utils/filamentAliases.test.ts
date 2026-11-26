/**
 * Fork (filament aliases): colours and profiles marked as the same count as
 * one in the UI's matching hints, as they do in the queue.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { filterCompatibleQueueItems } from '../../utils/printer';
import { normalizeColorForCompare } from '../../utils/amsHelpers';
import { aliasPreset, colorAliases, setFilamentAliases } from '../../utils/filamentAliases';
import type { PrintQueueItem } from '../../api/client';

const job = (color: string, idx: string): PrintQueueItem =>
  ({
    id: 1,
    filament_overrides: [{ slot_id: 1, type: 'PETG', color, tray_info_idx: idx, force_color_match: true }],
  }) as unknown as PrintQueueItem;

describe('filament aliases', () => {
  afterEach(() => setFilamentAliases(null));

  it('a file on Generic PETG fits a slot on a preset marked as the same', () => {
    const types = new Set(['PETG']);
    const loaded = new Set(['PETG:000000']);
    const variants = new Set(['PETG:000000:P1a2b3c4']);
    expect(filterCompatibleQueueItems([job('#000000', 'GFG99')], types, loaded, variants)).toHaveLength(0);

    setFilamentAliases({ colors: [], presets: [['GFG99', 'P1a2b3c4']] });
    expect(filterCompatibleQueueItems([job('#000000', 'GFG99')], types, loaded, variants)).toHaveLength(1);
    expect(aliasPreset('P1a2b3c4')).toBe('GFG99');
  });

  it('a colour marked as the same matches, in the hints and in colour comparisons', () => {
    const types = new Set(['PETG']);
    const loaded = new Set(['PETG:e2df60']);
    const variants = new Set(['PETG:e2df60:P1a2b3c4']);
    expect(filterCompatibleQueueItems([job('#DCDB4E', 'P1a2b3c4')], types, loaded, variants)).toHaveLength(0);

    setFilamentAliases({ colors: [['dcdb4e', '#E2DF60']], presets: [] });
    expect(filterCompatibleQueueItems([job('#DCDB4E', 'P1a2b3c4')], types, loaded, variants)).toHaveLength(1);
    expect(normalizeColorForCompare('#E2DF60FF')).toBe(normalizeColorForCompare('#dcdb4e'));
    expect(colorAliases('000000')).toEqual(['000000']);
  });
});
