/**
 * Fork: a text's hex colours with a square of each (components/HexColorText).
 */

import { Fragment, type ReactNode } from 'react';
import { ColorSquare } from '../components/HexColorText';

// #RRGGBB or #RRGGBBAA, not part of a longer run of hex digits (so neither
// "#1234567" nor a word that merely contains one).
const HEX_COLOR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})(?![0-9a-zA-Z])/g;

/** ``text`` with a square of the colour before each hex code in it. */
export function withColorSquares(text: string | null | undefined): ReactNode {
  if (!text) return text ?? null;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(HEX_COLOR)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(
      <span key={at} className="whitespace-nowrap">
        <ColorSquare hex={match[0]} className="mr-1" />
        {match[0]}
      </span>,
    );
    last = at + match[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts.map((part, i) => <Fragment key={i}>{part}</Fragment>);
}
