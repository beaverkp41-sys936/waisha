import { revalidateTag } from "next/cache";

/**
 * The copy desk has published; this is where it says the marketing footer is now stale.
 *
 * `web/components/Footer.tsx` reads the bar under this tag and caches it for five minutes,
 * because a line shown on every public page is not worth a database read per visitor. That
 * cache is the only copy on the platform that can keep saying something the office already
 * retired — the desk's own preview, the sign-in card and the portal bar all re-read per
 * visitor — so this route exists to end the five minutes on the save rather than on a deploy.
 *
 * It answers the same way to everyone and honours at most one revalidation per window, so the
 * whole exposure to an anonymous caller is one extra indexed read of `content_blocks` every
 * few seconds. The write it follows is still behind `control.content.manage` on the API.
 */
const WINDOW_MS = 2000;
let last = 0;

export async function POST() {
  const now = Date.now();
  if (now - last >= WINDOW_MS) {
    last = now;
    revalidateTag("footer");
  }
  return Response.json({ ok: true });
}
