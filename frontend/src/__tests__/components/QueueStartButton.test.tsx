/**
 * Fork: Start for a staged job outside the queue page (the printer card). A
 * refusal it has no dialog for shows the server's reason, not only "could
 * not start".
 */
import { describe, it, expect } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { QueueStartButton } from '../../components/QueueStartButton';

describe('QueueStartButton', () => {
  it("shows the server's reason when the start is refused", async () => {
    server.use(
      http.post('/api/v1/queue/:id/start', () =>
        HttpResponse.json({ detail: 'Printer is offline' }, { status: 400 }),
      ),
    );
    render(<QueueStartButton item={{ id: 3, created_by_id: null }} />);
    fireEvent.click(await screen.findByRole('button', { name: /Start/ }));
    expect(await screen.findByText('Failed to start print: Printer is offline')).toBeInTheDocument();
  });
});
