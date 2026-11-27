/**
 * Tests for the Button component.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '../../components/Button';

describe('Button', () => {
  it('renders children correctly', () => {
    render(<Button>Click me</Button>);

    expect(screen.getByRole('button')).toHaveTextContent('Click me');
  });

  it('handles click events', async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();

    render(<Button onClick={handleClick}>Click me</Button>);

    await user.click(screen.getByRole('button'));

    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('can be disabled', async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();

    render(
      <Button onClick={handleClick} disabled>
        Click me
      </Button>
    );

    const button = screen.getByRole('button');
    expect(button).toBeDisabled();

    await user.click(button);
    expect(handleClick).not.toHaveBeenCalled();
  });

  // Variant tests
  describe('variants', () => {
    it('applies primary variant styles by default', () => {
      render(<Button>Primary</Button>);

      const button = screen.getByRole('button');
      expect(button.className).toContain('bg-bambu-green');
    });

    it('applies secondary variant styles', () => {
      render(<Button variant="secondary">Secondary</Button>);

      const button = screen.getByRole('button');
      expect(button.className).toContain('bg-bambu-dark-tertiary');
    });

    it('applies danger variant styles', () => {
      render(<Button variant="danger">Danger</Button>);

      const button = screen.getByRole('button');
      expect(button.className).toContain('bg-red-600');
    });

    it('applies ghost variant styles', () => {
      render(<Button variant="ghost">Ghost</Button>);

      const button = screen.getByRole('button');
      expect(button.className).toContain('bg-transparent');
    });
  });

  // Size tests
  describe('sizes', () => {
    it('applies medium size by default', () => {
      render(<Button>Medium</Button>);

      const button = screen.getByRole('button');
      expect(button.className).toContain('px-4');
      expect(button.className).toContain('py-2');
    });

    it('applies small size styles', () => {
      render(<Button size="sm">Small</Button>);

      const button = screen.getByRole('button');
      expect(button.className).toContain('px-3');
      expect(button.className).toContain('py-1.5');
    });

    it('applies large size styles', () => {
      render(<Button size="lg">Large</Button>);

      const button = screen.getByRole('button');
      expect(button.className).toContain('px-6');
      expect(button.className).toContain('py-3');
    });

    // Fork: the touch minimum is dropped only for a fine primary pointer from
    // md up; any coarse pointer keeps it at every width (an iPad is touch).
    it.each([
      ['sm', '44px'],
      ['md', '44px'],
      ['lg', '48px'],
    ] as const)('keeps the %s touch minimum for a coarse pointer at any width', (size, min) => {
      render(<Button size={size}>Touch</Button>);

      const classes = screen.getByRole('button').className.split(/\s+/);
      expect(classes).toContain(`min-h-[${min}]`);
      expect(classes).toContain('md:pointer-fine:min-h-0');
      expect(classes).toContain(`any-pointer-coarse:min-h-[${min}]`);
      // Width alone never shrinks it.
      expect(classes).not.toContain('md:min-h-0');
    });
  });

  // Accessibility tests
  describe('accessibility', () => {
    it('has correct button role', () => {
      render(<Button>Accessible</Button>);

      expect(screen.getByRole('button')).toBeInTheDocument();
    });

    it('supports custom aria-label', () => {
      render(<Button aria-label="Custom label">Icon</Button>);

      expect(screen.getByRole('button')).toHaveAttribute(
        'aria-label',
        'Custom label'
      );
    });

    it('supports type attribute', () => {
      render(<Button type="submit">Submit</Button>);

      expect(screen.getByRole('button')).toHaveAttribute('type', 'submit');
    });
  });

  // Custom className test
  it('merges custom className with default styles', () => {
    render(<Button className="custom-class">Custom</Button>);

    const button = screen.getByRole('button');
    expect(button.className).toContain('custom-class');
    expect(button.className).toContain('bg-bambu-green'); // Still has default styles
  });

  // Disabled styles test
  it('applies disabled styles when disabled', () => {
    render(<Button disabled>Disabled</Button>);

    const button = screen.getByRole('button');
    expect(button.className).toContain('disabled:opacity-50');
    expect(button.className).toContain('disabled:cursor-not-allowed');
  });
});
