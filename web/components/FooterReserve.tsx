"use client";
import { useEffect } from "react";

/*
 * The contact bar is `position: sticky; bottom: 0`, so while a page is longer than the
 * viewport it floats over whatever is at the bottom edge — and the scroller has to keep
 * that much clear at the end of the content or the last line of a page lives under it.
 *
 * The height is not knowable from CSS: every word the bar carries comes off the command
 * center desk, so an address line, an hours line and a row of links can be added without
 * anybody touching a stylesheet. It measured 45px when the reserve was written, 84px after
 * the desk's second row, and 131px on a phone where the contact pair wraps — and the
 * 390px sweep found the sign-in button and the profile tab strip sitting in the difference.
 * So the bar reports its own height and the reserves read it.
 *
 * The fallback in globals.css keeps the old number for the first paint, before this
 * effect has run.
 */
export function FooterReserve() {
  useEffect(() => {
    // The copy of the desk's preview bar is not the bar that floats over anything, so it
    // is left out of the reading along with the `display: none` marketing footer that a
    // portal route carries beside its own — both would report a height no scroller needs.
    const bars = [...document.querySelectorAll<HTMLElement>(".app-footer")]
      .filter((b) => !b.closest(".footer-preview"));
    if (bars.length === 0) return;
    const write = () => {
      const h = Math.ceil(Math.max(0, ...bars.map((b) => b.getBoundingClientRect().height)));
      if (h > 0) document.documentElement.style.setProperty("--footer-h", `${h}px`);
    };
    write();
    // The desk's words arrive after mount on the portal shell (the bar fetches them), and
    // the keyboard, a rotation or a narrower window all change how many lines they make.
    const ro = new ResizeObserver(write);
    for (const b of bars) ro.observe(b);
    return () => ro.disconnect();
  }, []);
  return null;
}
