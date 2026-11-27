/**
 * Fork: a hex colour in a text comes with a square of that colour, so a
 * reason like "Needs PETG #408002" reads as a colour.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HexColorText } from '../../components/HexColorText';

function squares(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-testid="color-square"]'));
}

describe('HexColorText', () => {
  it('puts a square of the colour before each hex code and keeps the text', () => {
    const { container } = render(
      <p>
        <HexColorText text="No matching material/color. Waiting on PETG (#e2df60), PETG #408002FF" />
      </p>,
    );
    expect(container.textContent).toBe('No matching material/color. Waiting on PETG (#e2df60), PETG #408002FF');
    const found = squares(container);
    expect(found).toHaveLength(2);
    expect(found[0]).toHaveStyle({ backgroundColor: '#e2df60' });
    // The alpha of #RRGGBBAA is not drawn: a clear spool would show no square at all.
    expect(found[1]).toHaveStyle({ backgroundColor: '#408002' });
    expect(found.every((el) => el.getAttribute('aria-hidden') === 'true')).toBe(true);
  });

  it('leaves text with no hex colour as it is', () => {
    const { container } = render(<HexColorText text="Spool #12 · retry of #1234567 · #abc · #12345g" />);
    expect(container.textContent).toBe('Spool #12 · retry of #1234567 · #abc · #12345g');
    expect(squares(container)).toHaveLength(0);
  });

  it('renders nothing for no text', () => {
    const { container } = render(<HexColorText text={null} />);
    expect(container.innerHTML).toBe('');
    render(<HexColorText text="Needs PETG #DCDB4E" />);
    expect(screen.getByText('#DCDB4E')).toBeInTheDocument();
  });
});
