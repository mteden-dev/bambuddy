import { useState } from 'react';
import { Minus, Plus } from 'lucide-react';

interface PieceStepperProps {
  value: number;
  onChange: (value: number) => void;
  max: number;
  min?: number;
  /** Names the control for screen readers and tests. */
  label: string;
  /**
   * default: the picked value is green (pieces to print or keep).
   * danger: picked values above zero show red (bad pieces).
   * shelf: a count that takes pieces out of printing; a picked 0 stays
   * neutral and values above zero show sky, so it never reads as "print".
   */
  tone?: 'default' | 'danger' | 'shelf';
  disabled?: boolean;
}

// Up to this many, every value is a segment of its own: one tap, no keyboard.
const SEGMENTS_UP_TO = 4;

const cell =
  'min-w-9 h-9 pointer-coarse:min-w-11 pointer-coarse:h-11 px-2 text-sm font-medium transition-colors disabled:opacity-50';

/**
 * Fork (products): a count picked by touch. Small ranges (pieces on a plate,
 * boxes in an order line) are segments, 0 | 1 | 2 | 3; bigger ones a stepper,
 * − n +, whose middle field still takes a typed number.
 */
export function PieceStepper({ value, onChange, max, min = 0, label, tone = 'default', disabled }: PieceStepperProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  const picked = (n: number) => {
    if (tone === 'danger' && n > 0) return 'bg-red-600 text-white';
    if (tone === 'shelf') return n > 0 ? 'bg-sky-600 text-white' : 'bg-bambu-dark-tertiary text-white';
    return 'bg-bambu-green text-white';
  };

  if (max - min + 1 <= SEGMENTS_UP_TO + 1) {
    const values = Array.from({ length: max - min + 1 }, (_, i) => min + i);
    return (
      <div
        role="radiogroup"
        aria-label={label}
        className="inline-flex rounded-lg border border-bambu-dark-tertiary overflow-hidden"
      >
        {values.map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            disabled={disabled}
            onClick={() => onChange(n)}
            className={`${cell} border-l border-bambu-dark-tertiary first:border-l-0 ${
              value === n ? picked(n) : 'bg-bambu-dark text-bambu-gray-light hover:bg-bambu-dark-tertiary'
            }`}
          >
            {n}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div role="group" aria-label={label} className="inline-flex items-stretch rounded-lg border border-bambu-dark-tertiary overflow-hidden">
      <button
        type="button"
        aria-label="−"
        disabled={disabled || value <= min}
        onClick={() => onChange(clamp(value - 1))}
        className={`${cell} bg-bambu-dark text-bambu-gray-light hover:bg-bambu-dark-tertiary flex items-center justify-center`}
      >
        <Minus className="w-4 h-4" />
      </button>
      <input
        type="text"
        inputMode="numeric"
        aria-label={label}
        disabled={disabled}
        value={draft ?? String(value)}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = parseInt(e.target.value, 10);
          if (!Number.isNaN(n) && n >= min && n <= max) onChange(n);
        }}
        onBlur={() => {
          if (draft !== null) {
            const n = parseInt(draft, 10);
            onChange(Number.isNaN(n) ? value : clamp(n));
            setDraft(null);
          }
        }}
        className={`w-12 text-center bg-bambu-dark text-white text-sm border-x border-bambu-dark-tertiary focus:outline-none focus:bg-bambu-dark-tertiary ${
          tone === 'danger' && value > 0 ? 'text-red-400' : tone === 'shelf' && value > 0 ? 'text-sky-700 dark:text-sky-300' : ''
        }`}
      />
      <button
        type="button"
        aria-label="+"
        disabled={disabled || value >= max}
        onClick={() => onChange(clamp(value + 1))}
        className={`${cell} bg-bambu-dark text-bambu-gray-light hover:bg-bambu-dark-tertiary flex items-center justify-center`}
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );
}
