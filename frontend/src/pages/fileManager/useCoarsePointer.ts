import { useEffect, useState } from 'react';

// Any pointer is coarse: a phone, an iPad (also with a keyboard case or a
// trackpad attached, which still gets touched).
export const COARSE_POINTER_QUERY = '(any-pointer: coarse)';

function matches(): boolean {
  try {
    return window.matchMedia?.(COARSE_POINTER_QUERY).matches ?? false;
  } catch {
    return false;
  }
}

/** Fork: whether the device can be touched, decided by pointer, never by width. */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(matches);
  useEffect(() => {
    const query = window.matchMedia?.(COARSE_POINTER_QUERY);
    if (!query) return;
    const onChange = (e: MediaQueryListEvent) => setCoarse(e.matches);
    setCoarse(query.matches);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);
  return coarse;
}

/** Narrower than `breakpoint` (`sm` by default): a layout question, so by width. */
export function usePhoneWidth(breakpoint = 640): boolean {
  const [phone, setPhone] = useState(() => window.innerWidth < breakpoint);
  useEffect(() => {
    const onResize = () => setPhone(window.innerWidth < breakpoint);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  return phone;
}

// A 44px hit area around a small control on a touch device, without changing
// how it looks. The control must be positioned (relative or absolute).
export const TOUCH_HIT_AREA =
  "any-pointer-coarse:after:absolute any-pointer-coarse:after:content-[''] any-pointer-coarse:after:left-1/2 any-pointer-coarse:after:top-1/2 any-pointer-coarse:after:size-[44px] any-pointer-coarse:after:-translate-x-1/2 any-pointer-coarse:after:-translate-y-1/2";

// An icon button that is 44px on a touch device.
export const TOUCH_BUTTON = 'any-pointer-coarse:min-w-[44px] any-pointer-coarse:min-h-[44px] inline-flex items-center justify-center';
