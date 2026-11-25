/**
 * Tests for the PrinterQueueWidget component.
 *
 * This is a compact widget that shows "Next in queue" with the first pending
 * item's name and a "+N" badge if there are more items. Returns null when empty.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';
import { render } from '../utils';
import { PrinterQueueWidget } from '../../components/PrinterQueueWidget';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const mockQueueItems = [
  {
    id: 1,
    printer_id: 1,
    archive_id: 1,
    position: 1,
    status: 'pending',
    archive_name: 'First Print',
    printer_name: 'X1 Carbon',
    print_time_seconds: 3600,
    scheduled_time: null,
  },
  {
    id: 2,
    printer_id: 1,
    archive_id: 2,
    position: 2,
    status: 'pending',
    archive_name: 'Second Print',
    printer_name: 'X1 Carbon',
    print_time_seconds: 7200,
    scheduled_time: null,
  },
];

describe('PrinterQueueWidget', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/v1/queue/', ({ request }) => {
        const url = new URL(request.url);
        const printerId = url.searchParams.get('printer_id');
        if (printerId === '1') {
          return HttpResponse.json(mockQueueItems);
        }
        return HttpResponse.json([]);
      })
    );
  });

  describe('rendering', () => {
    it('shows next in queue label', async () => {
      render(<PrinterQueueWidget printerId={1} />);

      await waitFor(() => {
        expect(screen.getByText('Next in queue')).toBeInTheDocument();
      });
    });

    it('shows first pending item name', async () => {
      render(<PrinterQueueWidget printerId={1} />);

      await waitFor(() => {
        expect(screen.getByText('First Print')).toBeInTheDocument();
      });
    });

    it('shows additional items badge when multiple pending', async () => {
      render(<PrinterQueueWidget printerId={1} />);

      await waitFor(() => {
        // Shows "+1" badge since there are 2 items
        expect(screen.getByText('+1')).toBeInTheDocument();
      });
    });

    it('shows Waiting for unscheduled items', async () => {
      render(<PrinterQueueWidget printerId={1} />);

      await waitFor(() => {
        expect(screen.getByText('Waiting')).toBeInTheDocument();
      });
    });
  });

  describe('empty state', () => {
    it('renders nothing when no pending items', async () => {
      const { container } = render(<PrinterQueueWidget printerId={999} />);

      // Wait for query to resolve
      await waitFor(() => {
        // Widget returns null when empty, so container should have no visible widget
        expect(container.querySelector('a[href="/queue"]')).not.toBeInTheDocument();
      });
    });
  });

  describe('single item', () => {
    it('does not show badge when only one item', async () => {
      server.use(
        http.get('/api/v1/queue/', () => {
          return HttpResponse.json([mockQueueItems[0]]);
        })
      );

      render(<PrinterQueueWidget printerId={1} />);

      await waitFor(() => {
        expect(screen.getByText('First Print')).toBeInTheDocument();
      });

      // Should not have a "+N" badge
      expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
    });
  });

  describe('link behavior', () => {
    it('links to queue page', async () => {
      render(<PrinterQueueWidget printerId={1} />);

      await waitFor(() => {
        const link = screen.getByRole('link');
        expect(link).toHaveAttribute('href', '/queue');
      });
    });
  });
});

describe('PrinterQueueWidget: a next job waiting for Start (fork)', () => {
  const held = { ...mockQueueItems[0], manual_start: true, filament_short: true, waiting_reason: null, created_by_id: null };
  let starts: string[];

  beforeEach(() => {
    starts = [];
    server.use(
      http.get('/api/v1/queue/', () => HttpResponse.json([held, mockQueueItems[1]])),
      http.post('/api/v1/queue/:id/start', ({ request, params }) => {
        const url = new URL(request.url);
        starts.push(`${params.id}${url.search}`);
        if (!url.searchParams.get('skip_filament_check')) {
          return HttpResponse.json(
            {
              detail: {
                code: 'insufficient_filament',
                message: 'short',
                deficit: [{ slot_id: 2, required_grams: 120, remaining_grams: 40 }],
              },
            },
            { status: 409 },
          );
        }
        return HttpResponse.json({ ...held, manual_start: false });
      }),
    );
  });

  it('says why it will not start and starts it after asking about the short spool', async () => {
    const user = userEvent.setup();
    render(<PrinterQueueWidget printerId={1} />);
    expect(await screen.findByText('Next in queue waits for Start')).toBeInTheDocument();
    expect(screen.getByText('Insufficient filament for the assigned spool')).toBeInTheDocument();
    expect(screen.getByTestId('printer-queue-widget')).toHaveAttribute('data-hold', 'problem');
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByText(/Slot 2: needs 120 g, 40 g remaining/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Print Anyway' }));
    await waitFor(() => expect(starts).toEqual(['1', '1?skip_filament_check=true']));
  });
});
