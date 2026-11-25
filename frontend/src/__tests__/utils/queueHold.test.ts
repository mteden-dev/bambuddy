import { describe, expect, it } from 'vitest';
import { queueHold } from '../../utils/queueHold';

const t = (key: string) => key;
const item = (over: Record<string, unknown>) =>
  ({ status: 'pending', manual_start: true, filament_short: false, waiting_reason: null, ...over }) as Parameters<typeof queueHold>[0];

describe('queueHold (fork)', () => {
  it('says a short spool or a missing filament holds the job: a problem', () => {
    expect(queueHold(item({ filament_short: true }), t)).toEqual({ problem: true, text: 'queue.filamentShort.rowBadge' });
    expect(queueHold(item({ waiting_reason: 'Needs PLA Black' }), t)).toEqual({ problem: true, text: 'Needs PLA Black' });
  });

  it('says a job staged on purpose waits for Start, not a problem', () => {
    expect(queueHold(item({}), t)).toEqual({ problem: false, text: 'queue.hold.staged' });
  });

  it('has nothing to say about a job that starts by itself, or one not waiting', () => {
    expect(queueHold(item({ manual_start: false, waiting_reason: 'All printers busy' }), t)).toBeNull();
    expect(queueHold(item({ status: 'printing', filament_short: true }), t)).toBeNull();
  });
});
