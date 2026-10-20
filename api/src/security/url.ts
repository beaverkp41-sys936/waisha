import { z } from "zod";

/**
 * `z.string().url()` is not a scheme guard.
 *
 * It asks whether the string parses as a URL, and `new URL("javascript:alert(1)")`
 * parses perfectly well — so it happily stores a script in a column, along with `data:`
 * and `file:`. Nothing in the panel links out of a stored website today (every screen
 * prints the value as escaped text), which is the only reason this is a boundary fix
 * rather than a live incident: a hostile value in a public column is a promise that the
 * first `<a href>` drawn from it executes.
 */

const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HTTP_SCHEME = /^https?:\/\//i;

const MESSAGE = "Give a page address — https://example.co.tz.";

/** A website a person types: `https://` required, and http allowed for the offices that
 *  still have no certificate. Blank is not a value here — both forms drop the key. */
export const httpUrl = (max = 200) =>
  z.string().trim().min(1).max(max).refine((v) => HTTP_SCHEME.test(v.trim()), { message: MESSAGE });

/** The same rule for a column where an address may arrive without a scheme at all
 *  (`waisha.co.tz`): only a *claimed* scheme is judged, so a bare host stays writable
 *  and `javascript:` / `data:` never does. */
export const webAddress = (max = 300) =>
  z.string().trim().min(1).max(max).refine(
    (v) => !ANY_SCHEME.test(v.trim()) || HTTP_SCHEME.test(v.trim()), { message: MESSAGE });

/**
 * An address that is going to be put into an `href` by the platform itself.
 *
 * `webAddress` above tolerates a bare host because a listing's website column is printed as
 * text. A footer link is clicked, so a relative value would resolve against whatever page
 * the reader is on — and the reason this is an allowlist rather than a blocklist is that a
 * blocklist has to be right forever while an allowlist only has to be right once: React
 * escapes the string it puts in `href` but does not stop `javascript:` executing from one.
 */
const LINK_SCHEME = /^(https?|mailto|tel):/i;
const LINK_MESSAGE =
  "Give a full address the reader can click — https://…, mailto:… or tel:…";

export const linkAddress = (max = 300) =>
  z.string().trim().min(1).max(max).refine((v) => LINK_SCHEME.test(v.trim()),
    { message: LINK_MESSAGE });
