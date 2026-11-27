/**
 * Fork: text with every hex colour in it shown with a square of that colour.
 *
 * The queue's reasons ("Needs PETG #408002", "Waiting on PETG (#e2df60)"), the
 * missing filaments of a 409 and the colour substitution notes name colours
 * by their hex code, which nobody reads as a colour. Anything else in the
 * text is left as it is.
 */

import { withColorSquares } from '../utils/colorSquares';

export function ColorSquare({ hex, className = '' }: { hex: string; className?: string }) {
  const rgb = hex.replace(/^#/, '').slice(0, 6);
  return (
    <span
      aria-hidden="true"
      data-testid="color-square"
      className={`inline-block w-3 h-3 rounded-[3px] border border-black/20 dark:border-white/30 shrink-0 align-[-2px] ${className}`}
      style={{ backgroundColor: `#${rgb}` }}
    />
  );
}

export function HexColorText({ text }: { text: string | null | undefined }) {
  return <>{withColorSquares(text)}</>;
}
