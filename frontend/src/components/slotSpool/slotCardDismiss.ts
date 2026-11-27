import { createContext } from 'react';

/**
 * Fork (slot spools): closes the slot card the actions sit in. The card is
 * portaled above the dialogs (z-[60] over z-50), so an action that opens one
 * has to close the card first or it covers the dialog's own fields. Null
 * outside a slot card.
 */
export const SlotCardDismissContext = createContext<(() => void) | null>(null);
