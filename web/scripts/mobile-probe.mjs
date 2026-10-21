/**
 * Phone-width layout probe.
 *
 * A breakpoint cannot be tested from inside the app: the portal's own pages are
 * unframeable (X-Frame-Options DENY) and the browser the agent drives has no
 * viewport control. So this drives a headless Chrome over the DevTools protocol,
 * pins the emulation metrics to a real handset, and reads the layout back.
 *
 * It reports the three failure modes that matter on a 390px screen:
 *   overflow  — something reaches past the viewport, so the whole page scrolls sideways
 *   clipped   — a wide element (a table, a code block) is cut off by overflow:hidden,
 *               so its right-hand data is unreachable because nothing can scroll it
 *   tap       — a link or button measures under what a thumb lands on
 *
 * Content matters: an empty register fits any width. Seed a company first and pass
 * WAISHA_PROBE_TOKEN with an access token for it, or the shells render their no-data
 * states and every measurement is of the wrong page. A token that dies mid-sweep
 * redirects to /login, and that is the failure this script most nearly shipped with:
 * every page then measured the login card, every counter read zero, and the run looked
 * clean. So the verdict carries the path the browser landed on, and any page that moved
 * off the one asked for exits 1.
 *
 * Node's global fetch + WebSocket speak CDP directly, so there is no browser driver
 * dependency to install.
 *
 *   node web/scripts/mobile-probe.mjs --width 390 --height 844 --out .probe --pages /,/login,...
 *   WAISHA_PROBE_TOKEN=<accessToken> node web/scripts/mobile-probe.mjs ...   # authenticated shells
 *   MSYS2_ARG_CONV_EXCL='*' node web/scripts/mobile-probe.mjs ...   # from Git Bash, or every
 *                                         --pages value arrives as a rewritten Windows path
 *   ... --shots [--full]                  write one PNG per page into --out
 *   ... --contrast                        measure every sentence against the pixels actually
 *                                         behind it, because no other counter here can see a
 *                                         colour problem: a dark-on-dark page measures
 *                                         perfectly clean. See COLLECT_TEXT for the method.
 *                                         A sentence that a floating bar bites into is
 *                                         counted as `under` instead of graded — its backdrop
 *                                         is the bar's wash, which is a layout finding.
 *   ... --show-ok                         with --contrast, also print three lines that pass,
 *                                         so a clean page can be told apart from a sampler
 *                                         that measured nothing
 *   ... --eval '<expression>'             print the JSON of any expression, per page
 *   ... --open                            click the page's create control before measuring,
 *                                         because a form that only exists after a tap is the
 *                                         page a phone user actually has to fill in
 *   ... --click 'waiting on you'          click the first control whose words begin with
 *                                         this, for the same reason one tab deep
 *   ... --settle 20000                    ms a page may keep changing before it is measured
 *                                         anyway (default 12000)
 *   ... --quiet 4000                      the least time a page may be called settled
 *                                         (default 2500; see settle() for why a shorter
 *                                         floor measures an empty register)
 *
 * A page that never stills is printed as never-stilled, because a run that measured a
 * half-rendered page is the one failure mode this script cannot be allowed to report as
 * a pass: an empty register fits any width.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const list = (name, dflt) => String(flag(name, dflt)).split(",").filter(Boolean);

const BASE = flag("base", process.env.PROBE_BASE ?? "http://localhost:3000");
const WIDTH = Number(flag("width", 390));
const HEIGHT = Number(flag("height", 844));
const OUT = resolve(flag("out", ".mobile-probe"));
const PAGES = list("pages", "/login");
const FULL = args.includes("--full");
const SHOTS = args.includes("--shots");
const CONTRAST = args.includes("--contrast");
// Three passing lines printed next to the failures, so a run can be checked for the
// sampler itself being wrong rather than only for the pages being wrong.
const SHOW_OK = args.includes("--show-ok");
const PORT = Number(flag("port", 9333));
const TOKEN = process.env.WAISHA_PROBE_TOKEN ?? "";
// A /control desk is opened by the server-issued cookie, not by the bearer in sessionStorage,
// and the standing rule is a real sign-in rather than a forged credential. So whoever has just
// signed in hands that reply's whole `Set-Cookie` value through here and it is planted in the
// browser's own jar for the probe origin — attributes and all, because the control cookie is
// scoped to `Path=/api/v1/control` and a probe that widened the path would not be measuring the
// page a real seat loads. The value never reaches a terminal or a file.
const COOKIE = process.env.WAISHA_PROBE_COOKIE ?? "";
// A create form is a page a phone user has to use, and it only exists after a tap,
// so the load-time sweep cannot see it. --open clicks the create control first.
const OPEN = args.includes("--open");
// A tab is the same problem as a create form one: the panel a phone user has to live in
// only exists after a tap. --click names the control by the words on it, so a sweep can
// measure the queue tab or the register rather than only whatever a page opens on.
const CLICK = String(flag("click", "")).split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
// "What is wrong" is answered by the measures; "why" needs the live boxes. Pass an
// expression and its JSON is printed for every page alongside the verdict.
const EVAL = flag("eval", "");
// How long a page is allowed to keep changing before the sweep measures it anyway.
// The cap is set against what the dev API actually costs, not a round number:
// /notifications answers in 8.5s cold every time, /calendar/events in 3.1s, and the
// shell fires its wave the moment hydration ends — so 12s clipped a page that was
// simply waiting on the badge, and a clipped page is measured half-filled.
const SETTLE_CAP = Number(flag("settle", 20000));
// ... and the shortest time it may be called settled. See settle().
const MIN_QUIET = Number(flag("quiet", 2500));

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].filter(Boolean);

const chrome = CHROME_CANDIDATES.find((p) => {
  try {
    // eslint-disable-next-line no-sync
    return resolve(p) && p;
  } catch {
    return false;
  }
});
if (!chrome) {
  console.error("No Chrome/Edge found. Set CHROME_PATH.");
  process.exit(2);
}

// Keyed on the port, not the clock: two sweeps launched in the same millisecond
// would otherwise share a user-data-dir, and Chrome answers that by handing the
// second launch to the first instance and exiting — which reads as "no debug
// target" on the second port.
const profile = join(tmpdir(), `waisha-probe-${PORT}`);
const child = spawn(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    // An explicit start page, so the tab the sweep attaches to is a plain one. Launched with no
    // URL, Chrome opens chrome://newtab/ and registers its omnibox popup and one-google-bar
    // iframe alongside it as targets of their own.
    "about:blank"
  ],
  { stdio: "ignore" }
);

const stop = () => {
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked by a slow flush */ }
};
process.on("exit", stop);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTarget(deadlineMs = 30000) {
  const started = Date.now();
  // /json/list answers more rows than the one tab the sweep drives, and on a slow start some of
  // them are typed as pages. Attaching to an internal row leaves the socket open but every ask
  // about the page fails, so take a real tab — preferring the blank start page — and never an
  // omnibox popup, a devtools window or an extension page.
  const navigable = (t) =>
    t.type === "page" && t.webSocketDebuggerUrl &&
    !/^(devtools|chrome-extension|chrome-untrusted|view-source|voice):/i.test(t.url || "") &&
    !/omnibox/i.test(t.url || "");
  const rank = (t) => (/^(about:blank|chrome:\/\/newtab\/?|)$/i.test(t.url || "") ? 0 : 1);
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.filter(navigable).sort((a, b) => rank(a) - rank(b))[0];
      if (page) return page;
    } catch { /* chrome not listening yet */ }
    if (Date.now() - started > deadlineMs) throw new Error("Chrome did not expose a debug target");
    await sleep(300);
  }
}

/** The smallest possible CDP client: one socket, id-matched calls, event waiters. */
function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const waiters = [];
  const subs = [];
  let id = 0;
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { ok, fail } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? fail(new Error(msg.error.message)) : ok(msg.result);
    } else if (msg.method) {
      for (const w of waiters) if (w.method === msg.method) { clearTimeout(w.timer); w.ok(msg.params); }
      for (const s of subs) if (s.method === msg.method) s.cb(msg.params);
    }
  });
  const open = new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", () => rej(new Error("CDP socket failed")));
  });
  return {
    ready: open,
    send(method, params = {}) {
      return new Promise((res, rej) => {
        const n = ++id;
        pending.set(n, { ok: res, fail: rej });
        ws.send(JSON.stringify({ id: n, method, params }));
        setTimeout(() => { if (pending.delete(n)) rej(new Error(`${method} timed out`)); }, 60000);
      });
    },
    once(method, timeoutMs = 45000) {
      return new Promise((res, rej) => {
        const w = { method, ok: (p) => { remove(w); res(p); } };
        const remove = () => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); };
        waiters.push(w);
        w.timer = setTimeout(() => { remove(); rej(new Error(`${method} never fired`)); }, timeoutMs);
      });
    },
    on(method, cb) { subs.push({ method, cb }); },
    close() { try { ws.close(); } catch { /* already closed */ } }
  };
}

/** Everything the layout verdict needs, read from the live page in one round trip.
 *  This is a template literal, so a backtick anywhere inside it — including in a
 *  comment — closes the string and the file fails to parse at run time. */
const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const sel = (el) => {
    const cls = typeof el.className === 'string' ? el.className : '';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls.trim().split(/\\s+/).slice(0,3).join('.') : '');
  };
  const scrollerOf = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll)/.test(s.overflowX)) return p;
    }
    return null;
  };
  const overflow = [];
  const clipped = [];
  const elided = [];
  const tiny = [];
  let inScroller = 0;
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (cs.position === 'fixed' && Math.round(r.width) === vw) continue;
    if (r.right > vw + 1 || r.left < -1) {
      // Reaching past the viewport is only a fault when nothing can carry it back
      // into view. Inside a horizontal scroller — the nav strip, a register — the
      // rest of the row is one swipe away, so it is counted, not reported.
      if (scrollerOf(el)) { inScroller++; continue; }
      // Nor is the marquee's track a hazard: it is wider than its window on purpose
      // and the animation is what scrolls it. Masked by overflow:hidden, not lost.
      if (el.closest('.announce-viewport')) { inScroller++; continue; }
      overflow.push({ at: sel(el), tag: el.tagName.toLowerCase(),
        left: Math.round(r.left), right: Math.round(r.right),
        past: Math.round(Math.max(r.right - vw, -r.left)),
        pos: cs.position, text: (el.textContent || '').trim().slice(0, 60) });
    }
    const ox = cs.overflowX;
    if (el.scrollWidth > el.clientWidth + 4 && (ox === 'hidden' || ox === 'clip')) {
      // The announcement ticker is a marquee: its track is wider than the window on
      // purpose and the animation is what scrolls it. Not a clipped hazard.
      if (el.classList.contains('announce-viewport')) continue;
      // Same for sr-only, which is a 1px box holding a whole sentence by design.
      if (el.classList.contains('sr-only')) continue;
      // Nor a text field: its scrollWidth is the value sticking past the box while the
      // caret carries the rest into view on focus. Only an element that cannot scroll
      // at all has actually lost something.
      if (el.matches('input, textarea')) continue;
      // And nor a map pane, which is the world inside a window and is panned by
      // dragging; the tiles past its edge are one swipe away, not gone.
      if (el.classList.contains('leaflet-container')) continue;
      // An ellipsis is a decision, not an accident: a truncate class says "this label is
      // long, show the first words and three dots", and the reader can still tell one row
      // from the next. A box that cuts the tail off with no dots is the hazard. They are
      // counted apart so the clipped column means lost content, not styled text.
      const saysMore = cs.textOverflow === 'ellipsis';
      (saysMore ? elided : clipped).push({ at: sel(el), lost: el.scrollWidth - el.clientWidth,
        node: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 50) });
    }
    const tappable = el.matches('a, button, [role="button"], input[type=submit], summary');
    // WCAG 2.5.8 excuses a target whose size is set by the text it sits in: a link inside a
    // sentence cannot be padded out to a thumb without tearing the line apart, and the reader
    // has the rest of the sentence to aim at either way. Two shapes prove that — words in the
    // same text flow on either side of the anchor, or a paragraph/list item/heading that is
    // mostly prose. A link alone in a div, a table cell or at the end of a section is a
    // control ("← All cargo files", a trip's short code) and is counted.
    // NB: this whole function is a template literal, so a backslash has to be doubled before
    // it survives into the page. The split below is written with two. Written with one it
    // reaches the page as a split on the letter s, which reads every sentence as one long
    // word, excuses nothing, and reports prose links as tap hazards.
    const boxed = cs.display === 'inline' || cs.display === 'inline-block';
    const words = (t) => t.trim().split(/\\s+/).filter((w) => w.length > 1).length;
    const sibText = (n) => (n && n.nodeType === 3 ? (n.textContent || '') : '');
    const proseHost = /^(P|LI|H1|H2|H3|H4|BLOCKQUOTE|SMALL|DD)$/.test(el.parentElement?.tagName || '');
    const hostWords = proseHost ? words((el.parentElement?.innerText || '').replace(el.textContent || '', ' ')) : 0;
    const inSentence = boxed && (words(sibText(el.previousSibling)) + words(sibText(el.nextSibling)) >= 2 || hostWords >= 3);
    // Leaflet builds its own chrome and its own pins. The attribution is a legal credit the
    // library styles at 11px inside its control, and a marker's box IS the place it marks —
    // growing either one misstates the map, and the same detail is reachable from the register
    // beside it. Counted, not reported.
    const mapChrome = el.closest('.leaflet-control-attribution') || el.classList.contains('leaflet-marker-icon');
    if (tappable && mapChrome) inScroller++;
    else if (tappable && !inSentence && !el.closest('[hidden]') && (r.height < 34 || r.width < 30) && cs.pointerEvents !== 'none') {
      tiny.push({ at: sel(el), w: Math.round(r.width), h: Math.round(r.height),
        text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40) });
    }
  }
  const byPast = (a, b) => b.past - a.past || b.lost - a.lost;
  return {
    vw, vh: document.documentElement.clientHeight,
    // Where the browser actually landed. A shell page that answers /login means the
    // token died mid-sweep, and every hazard counter would then read zero — which is
    // the one result a sweep must never be able to claim by accident.
    loc: location.pathname,
    scrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body ? document.body.scrollWidth : 0,
    sidewaysScroll: document.documentElement.scrollWidth > vw + 1,
    overflow: overflow.sort(byPast).slice(0, 14),
    overflowCount: overflow.length,
    inScroller,
    clipped: clipped.sort((a, b) => b.lost - a.lost).slice(0, 10),
    elided: elided.sort((a, b) => b.lost - a.lost).slice(0, 6),
    elidedCount: elided.length,
    tiny: tiny.sort((a, b) => a.h - b.h).slice(0, 10),
    tinyCount: tiny.length,
    h1: (() => { const h = document.querySelector('h1'); if (!h) return null;
      const r = h.getBoundingClientRect(); const cs = getComputedStyle(h);
      return { size: cs.fontSize, h: Math.round(r.height), lines: Math.round(r.height / parseFloat(cs.lineHeight || 16)) }; })(),
    sidebar: (() => { const s = document.querySelector('.sidebar'); if (!s) return null;
      const r = s.getBoundingClientRect();
      return { display: getComputedStyle(s).display, w: Math.round(r.width), left: Math.round(r.left) }; })(),
    topbar: (() => { const s = document.querySelector('.topbar'); if (!s) return null;
      const r = s.getBoundingClientRect();
      return { h: Math.round(r.height), w: Math.round(r.width), scrollW: s.scrollWidth }; })()
  };
})()`;

/**
 * Contrast, measured rather than guessed.
 *
 * Every other counter here reads geometry, so a page whose sentences are the same colour
 * as the photo behind it measures clean and reads blank to a person. The old audit walked
 * the DOM looking for an ancestor with a background — which is blind to the two things that
 * decide the answer: the photo shows through a 58%-opaque veil, and a colour can be set
 * inline, in a class, or by a token that flips in a dark scheme.
 *
 * So this asks the browser what is actually on the screen. Pass one collects every element
 * holding its own words with its computed colour and box. Pass two hides all the text on
 * the page (colour to transparent, shadow off — backgrounds and photos stay) and takes a
 * screenshot, which is now a picture of nothing but backdrops. Pass three samples the
 * average pixel of each box out of that picture and runs the WCAG ratio against the colour
 * the text was going to be drawn in. A sentence over the bare photo at 2.1:1 fails here the
 * same way it fails in the office.
 *
 * Still a template literal: no backticks, and no dollar-brace anywhere inside it.
 */
const COLLECT_TEXT = `(() => {
  const out = [];
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const sel = (el) => {
    const cls = typeof el.className === 'string' ? el.className : '';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls.trim().split(/\\s+/).slice(0,3).join('.') : '');
  };
  for (const el of document.querySelectorAll('body *')) {
    // Only a node that carries words of its own. A div wrapping a paragraph is measured
    // by the paragraph, and its box is the whole card — sampling that would average the
    // sentence's own pixels into its backdrop.
    let own = false;
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && (n.textContent || '').trim().length > 1) { own = true; break; }
    }
    if (!own) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
    // WCAG 1.4.3 exempts text that is part of an inactive control, and a dimmed button is
    // the point of the dimming. Reporting one as a colour failure would send the next
    // reader to darken a state that is supposed to look dead.
    if (el.closest(':disabled, [aria-disabled="true"], fieldset[disabled]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) continue;
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
    // Which ancestor, if any, paints anything behind these words. A card can carry the
    // bg-surface class and still be see-through here — the veil, the photo and a blur
    // are what the reader actually sees — so the host is named by what it paints, not
    // by what it is called. The pixel sample below is the verdict; this is the address.
    let host = 'photo';
    for (let p = el; p; p = p.parentElement) {
      const b = getComputedStyle(p).backgroundColor;
      const m = String(b).match(/[\\d.]+/g);
      if (m && (m.length < 4 || parseFloat(m[3]) > 0.05)) {
        const cls = typeof p.className === 'string' ? p.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
        host = (cls || p.tagName.toLowerCase()) + (p === el ? '' : ' up' + (p === el.parentElement ? '1' : ''));
        break;
      }
      if (!p.parentElement || p.parentElement === document.body) break;
    }
    // A line the footer, a sticky bar or a modal has covered is not a colour failure —
    // it is a different one, and mixing the two would send the next reader hunting for a
    // token that is not the problem. The hit test at the centre of the box is what the
    // browser itself says is on top there.
    //
    // The four corners are tested as well, because a bar can bite into a box without
    // reaching its middle: the profile tab strip measured 41px tall with 17 of them under
    // the contact bar, so its centre hit itself while 40% of its backdrop was somebody
    // else's wash. Centre foreign -> covered, skipped quietly. Corner foreign -> under:
    // also not a colour verdict, but counted, because a row that is *permanently* under
    // the bar is a layout defect worth naming.
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const mine = (x, y) => {
      const t = document.elementFromPoint(x, y);
      return !!t && (t === el || el.contains(t) || t.contains(el));
    };
    const covered = !mine(cx, cy);
    const inset = 1;
    const under = !covered && !(
      mine(r.left + inset, r.top + inset) &&
      mine(r.right - inset, r.top + inset) &&
      mine(r.left + inset, r.bottom - inset) &&
      mine(r.right - inset, r.bottom - inset));
    out.push({
      sel: sel(el),
      text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
      color: cs.color, size: Math.round(parseFloat(cs.fontSize) * 10) / 10,
      weight: cs.fontWeight, style: cs.fontStyle,
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      host: host, covered: covered, under: under
    });
  }
  return out;
})()`;

/** Applied around the second screenshot so the picture holds only backdrops. */
const HIDE_TEXT_ON = "*, *::before, *::after { color: transparent !important;" +
  " -webkit-text-fill-color: transparent !important; text-shadow: none !important; }";

const SAMPLE_TEXT = `(async () => {
  const items = __ITEMS__;
  const img = new Image();
  img.src = __DATA__;
  await img.decode();
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const scale = img.width / document.documentElement.clientWidth;
  const chan = (v) => { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (r, g, b) => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const parse = (c) => { const m = String(c).match(/[\\d.]+/g); return m ? [ +m[0], +m[1], +m[2], m.length > 3 ? +m[3] : 1 ] : null; };
  const bad = [];
  const ok = [];
  const unders = [];
  let checked = 0;
  let covered = 0;
  let under = 0;
  let worst = 99;
  for (const it of items) {
    const c = parse(it.color);
    if (!c || c[3] === 0) continue;
    if (it.covered) { covered++; continue; }
    // Partly under a floating bar: the sample would average the bar's wash into the
    // backdrop and blame a colour token for a piece of layout. Counted, not graded —
    // and named, because "3 sentences sit under the bar" is only actionable if the run
    // says which ones.
    if (it.under) {
      under++;
      if (unders.length < 6) unders.push({ sel: it.sel, text: it.text, box: it.box, host: it.host });
      continue;
    }
    const x = Math.max(0, Math.round(it.box[0] * scale));
    const y = Math.max(0, Math.round(it.box[1] * scale));
    const w = Math.min(img.width - x, Math.round(it.box[2] * scale));
    const h = Math.min(img.height - y, Math.round(it.box[3] * scale));
    if (w < 3 || h < 3) continue;
    const d = ctx.getImageData(x, y, w, h).data;
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++; }
    if (!n) continue;
    sr /= n; sg /= n; sb /= n;
    // A translucent text colour lands over the backdrop, so composite it before judging.
    const a = c[3];
    const r = ratio(lum(c[0] * a + sr * (1 - a), c[1] * a + sg * (1 - a), c[2] * a + sb * (1 - a)), lum(sr, sg, sb));
    checked++;
    if (r < worst) worst = r;
    const large = it.size >= 24 || (it.size >= 18.66 && +it.weight >= 700);
    const row = { sel: it.sel, text: it.text, color: it.color, size: it.size, weight: it.weight,
      ratio: Math.round(r * 100) / 100, host: it.host,
      bg: 'rgb(' + Math.round(sr) + ',' + Math.round(sg) + ',' + Math.round(sb) + ')' };
    if (r < (large ? 3 : 4.5)) bad.push(row);
    else if (ok.length < 3) ok.push(row);
  }
  bad.sort((p, q) => p.ratio - q.ratio);
  return { checked: checked, covered: covered, under: under, underItems: unders,
    worst: Math.round(worst * 100) / 100,
    bad: bad.slice(0, 12), badCount: bad.length, ok: ok };
})()`;

/** Open the create form a page only shows after a tap. Verbs are the ones this
 *  codebase uses for form panels, and anything that reads like a destructive act is
 *  refused, because a sweep must not be able to delete a company.
 *  Again a template literal: no backticks in here. */
const OPEN_FORM = `(() => {
  const opener = /^(\\+?\\s*)?(add|new|create|raise|report|book)\\b/i;
  const shown = /^(close|hide|cancel|done|back)\\b/i;
  const danger = /delete|remove|revoke|suspend|block|wipe|reset/i;
  const text = (el) => (el.textContent || '').trim();
  // A panel's own dismiss control is a short command — "Close", "Close file", "Cancel".
  // A filter chip called "Back on the road" is not, and treating it as one made the sweep
  // report a form it never opened: the register was measured with its rows closed.
  const dismisses = (el) => {
    const t = text(el);
    return shown.test(t) && t.split(/\\s+/).length <= 2 && t.length <= 12;
  };
  const btns = [...document.querySelectorAll('.app-main button, .app-main a.waisha-btn')]
    .filter(el => !el.closest('[hidden]') && el.getBoundingClientRect().height > 0);
  const already = btns.find(dismisses);
  if (already) return 'already open (' + text(already).slice(0, 20) + ')';
  const hit = btns.find(el => opener.test(text(el)) && !danger.test(text(el)));
  if (!hit) return 'no create control';
  hit.click();
  return 'clicked ' + text(hit).slice(0, 24);
})()`;

/** Same refusal rule as OPEN_FORM: a sweep may open a panel, never undo a record.
 *  One word per pass, so a control that only exists one tap deep — a row's Edit button
 *  behind a tab — is found after the tab it lives under has rendered. Again a template
 *  literal: no backticks in here. */
const clickForm = (want) => `(() => {
  const want = ${JSON.stringify(want)};
  const danger = /delete|remove|revoke|suspend|block|wipe|reset/i;
  const text = (el) => (el.textContent || '').trim().toLowerCase();
  const btns = [...document.querySelectorAll('.app-main button, .app-main a.waisha-btn')]
    .filter(el => !el.closest('[hidden]') && el.getBoundingClientRect().height > 0);
  const hit = btns.find(el => text(el).startsWith(want) && !danger.test(text(el)));
  if (!hit) return 'no ' + want;
  hit.click();
  return want + ' -> ' + text(hit).slice(0, 24);
})()`;

/** A page is not "here" when load fires: a client component fetches after hydration
 *  and a dev server compiles the route on its first hit. Wait until the DOM stops
 *  growing AND nothing is still being asked for, rather than guessing a sleep — too
 *  short measures a half-rendered page (the calendar read clean for two runs because
 *  its chips had not arrived), too long wastes a minute per page. The pair is what
 *  makes the wait cheap: a page with no data lands in ~3s, a page that fills a
 *  register is measured the moment its last response is in. Returns the ms it took
 *  plus what it gave up on. */
const STABLE = `(() => document.querySelectorAll('body *').length + '|' + (document.body ? document.body.innerText.length : 0) + '|' + performance.getEntriesByType('resource').length)()`;

async function settle(cdp, inflight) {
  const started = Date.now();
  let prev = "";
  let same = 0;
  while (Date.now() - started < SETTLE_CAP) {
    const { result } = await cdp.send("Runtime.evaluate", { expression: STABLE, returnByValue: true });
    const sig = String(result.value);
    same = sig === prev ? same + 1 : 0;
    // The floor is not decoration: between the server-rendered HTML and the client
    // component's first fetch there is a quiet second and a half while dev-mode chunks
    // compile and hydrate. Declare stability inside that — before the request exists,
    // so an empty network queue proves nothing — and every page reads as an empty
    // register, which is precisely how a run reports zero hazards for free. Measured on
    // /app/cfa/calendar: both mount fetches were issued at ~1.0s and answered at 5.5s
    // and 8.5s, so the floor has to clear the issue time, not the answer time; the
    // answer is what the queue is for.
    if (same >= 2 && inflight.size === 0 && Date.now() - started > MIN_QUIET) {
      return { ms: Date.now() - started, waiting: "" };
    }
    prev = sig;
    await sleep(300);
  }
  return { ms: -SETTLE_CAP, waiting: [...inflight.values()].slice(0, 2)
    .map((u) => u.replace(/^https?:\/\//, "").slice(0, 60)).join(", ") || "dom" };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const target = await waitForTarget();
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: true });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await cdp.send("Emulation.setUserAgentOverride", {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
  });
  if (TOKEN) {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `try { sessionStorage.setItem('waisha_access', ${JSON.stringify(TOKEN)}); } catch (e) {}`
    });
  }
  if (COOKIE) {
    const [pair, ...attrs] = COOKIE.split(";").map((s) => s.trim());
    const eq = pair.indexOf("=");
    const attr = (n) => attrs.find((a) => a.toLowerCase().startsWith(`${n}=`))
      ?.slice(n.length + 1).trim();
    const sameSite = attr("SameSite");
    await cdp.send("Network.setCookie", {
      name: pair.slice(0, eq).trim(),
      value: pair.slice(eq + 1).trim(),
      url: BASE,
      path: attr("Path") || "/",
      httpOnly: attrs.some((a) => a.toLowerCase() === "httponly"),
      ...(sameSite ? { sameSite: sameSite.charAt(0).toUpperCase() + sameSite.slice(1).toLowerCase() } : {})
    });
  }

  // The queue settle() waits for. Dev-mode noise that never closes would otherwise
  // pin every page to the cap: the HMR socket and the hot-update polls are connections,
  // not data. Neither is the router warming the link it just rendered — a `?_rsc=`
  // prefetch answers a page nobody asked for, and holding the queue open for it made
  // /dashboard read as still-moving while the calendar's RSC payload crossed the wire.
  // Two more never close by design, so neither may hold a page open: the board's live
  // wire (/board/stream answers an event-stream and stays open until the page unloads),
  // and anything the browser itself asks for — a `chrome-untrusted://` new-tab poll
  // appeared on /app/account and pinned it to the cap while every tile was on screen.
  // Everything the page itself asks for counts, including /notifications, whose 8.5s is
  // exactly the wait a badge's width depends on.
  const inflight = new Map();
  const NOT_DATA = /webpack-hmr|sockjs|hot-update|\.map(\?|$)|favicon|[?&]_rsc=|\/stream(\?|$)/i;
  cdp.on("Network.requestWillBeSent", (p) => {
    if (!/^https?:/i.test(p.request.url)) return;
    if (!NOT_DATA.test(p.request.url)) inflight.set(p.requestId, p.request.url);
  });
  const finish = (id) => inflight.delete(id);
  cdp.on("Network.loadingFinished", (p) => finish(p.requestId));
  cdp.on("Network.loadingFailed", (p) => finish(p.requestId));

  const results = [];
  for (const path of PAGES) {
    // Git Bash rewrites an argument that looks like a POSIX absolute path before the
    // interpreter sees it, so --pages /app/office/attendance arrives as
    // C:/Program Files/Git/app/office/attendance and CDP answers the glued url with
    // "Cannot navigate to invalid URL" — a browser-flavoured message for a shell-side
    // change. Naming the cause here is what saves the next hour.
    if (!path.startsWith("/")) {
      throw new Error(`page path must reach this script unchanged, got ${JSON.stringify(path)} — `
        + "run it with MSYS2_ARG_CONV_EXCL='*' (Git Bash) or pass a full http(s) url");
    }
    const url = `${BASE}${path}`;
    const loaded = cdp.once("Page.loadEventFired", 45000);
    inflight.clear();
    await cdp.send("Page.navigate", { url });
    try { await loaded; } catch (e) { console.error(`${path}: ${e.message}`); }
    // Client components fetch after hydration; let the page finish before the verdict.
    await sleep(600);
    const page = await settle(cdp, inflight);
    const settled = page.ms;
    let opened = "";
    let clicked = "";
    let settledForm = 0;
    let waitingForm = "";
    if (OPEN) {
      const hit = await cdp.send("Runtime.evaluate",
        { expression: OPEN_FORM, returnByValue: true, awaitPromise: true });
      opened = String(hit.exceptionDetails ? "click threw" : hit.result.value);
      // The panel a tap reveals fetches its own picklists, so it gets the same
      // settle as the page underneath it.
      if (hit.result && hit.result.value && !String(hit.result.value).startsWith("no create")) {
        const form = await settle(cdp, inflight);
        settledForm = form.ms;
        waitingForm = form.waiting;
      } else {
        await sleep(700);
      }
    }
    for (const want of CLICK) {
      const hit = await cdp.send("Runtime.evaluate",
        { expression: clickForm(want), returnByValue: true, awaitPromise: true });
      const got = String(hit.exceptionDetails
        ? "click threw " + String(hit.exceptionDetails.exception?.description ?? "").split("\n")[0].slice(0, 60)
        : hit.result.value);
      clicked += (clicked ? " | " : "") + got;
      if (!got.startsWith("no ")) {
        const panel = await settle(cdp, inflight);
        settledForm = panel.ms;
        waitingForm = panel.waiting;
      } else {
        await sleep(700);
      }
    }
    const { result } = await cdp.send("Runtime.evaluate",
      { expression: MEASURE, returnByValue: true, awaitPromise: true });
    const m = result.value ?? { error: "measure returned nothing" };
    m.path = path;
    m.opened = opened;
    m.clicked = clicked;
    m.settled = settled;
    m.settledForm = settledForm;
    m.waiting = waitingForm || page.waiting;
    const short = path.replace(/\/+$/, "") || "/";
    const landed = (m.loc || "").replace(/\/+$/, "") || "/";
    // One page is a redirect on purpose: app/page.tsx is `redirect("/login")`, so the
    // root always lands on the sign-in screen whether or not the token is alive. Naming
    // it keeps the dead-token alarm working for the other 65 pages.
    const BY_DESIGN = { "/": "/login" };
    const moved = !!m.loc && landed !== short && BY_DESIGN[short] !== landed;
    m.moved = moved;
    m.redirectOnly = BY_DESIGN[short] === landed;
    if (CONTRAST) {
      const list = await cdp.send("Runtime.evaluate",
        { expression: COLLECT_TEXT, returnByValue: true, awaitPromise: true });
      const items = Array.isArray(list.result.value) ? list.result.value : [];
      // The second picture is the page with its words gone: whatever is left under a
      // sentence is the backdrop that sentence has to survive, photo, veil and glass
      // included, with no need to model any of them here.
      const style = "(() => { let s = document.getElementById('probe-hide-text');"
        + " if (!s) { s = document.createElement('style'); s.id = 'probe-hide-text';"
        + " s.textContent = " + JSON.stringify(HIDE_TEXT_ON) + "; document.head.appendChild(s); }"
        + " return 1; })()";
      const unstyle = "(() => { const s = document.getElementById('probe-hide-text');"
        + " if (s) s.remove(); return 1; })()";
      await cdp.send("Runtime.evaluate", { expression: style, returnByValue: true });
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      await cdp.send("Runtime.evaluate", { expression: unstyle, returnByValue: true });
      // split/join, not replace: a page's own words can hold a dollar sign, and replace()
      // would read it as a substitution pattern in the middle of the injected expression.
      const expr = SAMPLE_TEXT
        .split("__ITEMS__").join(JSON.stringify(items))
        .split("__DATA__").join(JSON.stringify("data:image/png;base64," + shot.data));
      const got = await cdp.send("Runtime.evaluate",
        { expression: expr, returnByValue: true, awaitPromise: true });
      m.contrast = got.exceptionDetails
        ? { error: String(got.exceptionDetails.exception?.description ?? "sample threw").split("\n")[0].slice(0, 90) }
        : (got.result.value ?? { error: "sample returned nothing" });
    }

    if (SHOTS) {
      const shot = await cdp.send("Page.captureScreenshot",
        { format: "png", captureBeyondViewport: FULL, fromSurface: true });
      const file = join(OUT, `w${WIDTH}-${short.replace(/[^\w.-]+/g, "_") || "root"}.png`);
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      m.shot = file;
    }
    results.push(m);
    const verdict = moved ? `NOT THE PAGE -> ${m.loc}`
      : m.sidewaysScroll ? `OVERFLOWS by ${m.scrollW - m.vw}px` : "fits";
    const note = (ms) => ms < 0 ? `never-stilled(${page.waiting})` : `${(ms / 1000).toFixed(1)}s`;
    console.log(
      `${short.padEnd(28)} ${verdict.padEnd(24)} ovf=${String(m.overflowCount).padStart(2)} ` +
      `clipped=${String(m.clipped.length).padStart(2)} elid=${String(m.elidedCount).padStart(2)} ` +
      `tiny=${String(m.tinyCount).padStart(2)} ` +
      (m.contrast ? `faint=${String(m.contrast.badCount ?? "?").padStart(2)}/${String(m.contrast.checked ?? "?").padStart(3)} ` +
        `worst=${m.contrast.worst ?? m.contrast.error ?? "?"} ` +
        `under=${String(m.contrast.under ?? 0).padStart(2)} ` : "") +
      `settle[${note(settled)}${settledForm ? "+" + note(settledForm) : ""}] ` +
      `${m.sidebar ? `sidebar[${m.sidebar.display} ${m.sidebar.w}px]` : ""}${opened ? ` form[${opened}]` : ""}${clicked ? ` tab[${clicked}]` : ""}`
    );
    for (const o of m.overflow.slice(0, 4)) console.log(`    past ${String(o.past).padStart(4)}px  ${o.pos.padEnd(8)} ${o.at}  ${o.text ? JSON.stringify(o.text) : ""}`);
    for (const o of m.clipped.slice(0, 3)) console.log(`    cut  ${String(o.lost).padStart(4)}px  ${o.at}`);
    for (const o of m.elided.slice(0, 2)) console.log(`    elid ${String(o.lost).padStart(4)}px  ${o.at}  ${o.text ? JSON.stringify(o.text) : ""}`);
    for (const o of m.tiny.slice(0, 3)) console.log(`    tap  ${String(o.w).padStart(3)}x${String(o.h).padEnd(3)}  ${o.at}  ${o.text ? JSON.stringify(o.text) : ""}`);
    // `sel` is the address the sampler carries — the geometry rows have an `at` path, but a
    // faint line is named by the element and its words, and printing a missing field here
    // would read as "no location" rather than "this channel never had one".
    for (const o of (m.contrast?.bad ?? []).slice(0, 6)) {
      console.log(`    faint ${String(o.ratio).padStart(4)}:1 ${o.size}px ${String(o.host).padEnd(18)} ` +
        `${o.color} over ${o.bg}  ${String(o.sel).slice(0, 34).padEnd(34)}  ${JSON.stringify(o.text)}`);
    }
    if (SHOW_OK) for (const o of (m.contrast?.ok ?? [])) {
      console.log(`    ok    ${String(o.ratio).padStart(4)}:1 ${o.size}px ${String(o.host).padEnd(18)} ` +
        `${o.color} over ${o.bg}  ${String(o.sel).slice(0, 34).padEnd(34)}  ${JSON.stringify(o.text)}`);
    }
    if (m.contrast?.error) console.log(`    faint -- ${m.contrast.error}`);
    if (EVAL) {
      const why = await cdp.send("Runtime.evaluate",
        { expression: EVAL, returnByValue: true, awaitPromise: true });
      // A silent `undefined` here reads like "nothing wrong" when it can also mean
      // "the expression threw", so the exception is printed instead of swallowed.
      console.log(`    why  ${JSON.stringify(
        why.exceptionDetails ? why.exceptionDetails.exception?.description ?? why.exceptionDetails.text
          : why.result.value)}`);
    }
  }

  writeFileSync(join(OUT, `probe-${WIDTH}.json`), JSON.stringify(results, null, 1));
  const bad = results.filter((r) => r.sidewaysScroll || r.clipped.length);
  const faint = results.filter((r) => (r.contrast?.badCount ?? 0) > 0 || r.contrast?.error);
  const movedPages = results.filter((r) => r.moved);
  const unsettled = results.filter((r) => r.settled < 0 || r.settledForm < 0);
  console.log(`\n${results.length} pages at ${WIDTH}x${HEIGHT}; ${bad.length} with overflow or clipped content -> ${join(OUT, `probe-${WIDTH}.json`)}`);
  if (CONTRAST) {
    const lines = results.reduce((n, r) => n + (r.contrast?.badCount ?? 0), 0);
    const checked = results.reduce((n, r) => n + (r.contrast?.checked ?? 0), 0);
    const under = results.reduce((n, r) => n + (r.contrast?.under ?? 0), 0);
    console.log(`CONTRAST: ${lines} faint sentence(s) of ${checked} measured, on ${faint.length} page(s).`);
    if (under) {
      // Not a colour verdict, and not nothing either. The sweep measures at the top of the
      // scroll, so a bar that is pinned to the viewport edge covers whatever happens to be
      // sitting at the fold — that is what a sticky bar means, and the page reserves its
      // height (see --footer-h) so the tail of the scroll is clear. What this list is for is
      // the sentence that stays under it: a control that lives at the fold on every page of
      // a shell is a control nobody reads.
      console.log(`?? ${under} sentence(s) sit partly under the floating contact bar at the fold —` +
        ` not graded for colour, and a layout question rather than a palette one:`);
      for (const r of results.filter((x) => (x.contrast?.under ?? 0) > 0)) {
        const top = (r.contrast.underItems ?? [])[0];
        console.log(`  ${String(r.path).padEnd(30)} ${String(r.contrast.under).padStart(3)} under` +
          (top ? `  ${String(top.sel).slice(0, 32).padEnd(32)} ${JSON.stringify(top.text)}` : ""));
      }
    }
    for (const r of faint) {
      const top = (r.contrast.bad ?? [])[0];
      console.log(`  ${String(r.path).padEnd(30)} ${String(r.contrast.badCount).padStart(3)} faint` +
        (top ? `  worst ${top.ratio}:1 ${JSON.stringify(top.text)}` : `  ${r.contrast.error}`));
    }
  }
  if (unsettled.length) {
    // Their counters still print, but a page measured while still moving is a page whose
    // zeroes mean nothing — an empty register fits any width.
    console.log(`?? ${unsettled.length} page(s) were still moving when measured: ` +
      unsettled.map((r) => `${r.path}${r.waiting ? ` (${r.waiting})` : ""}`).join(", "));
  }
  if (movedPages.length) {
    console.log(`!! ${movedPages.length} page(s) never rendered their shell: ` +
      movedPages.map((r) => `${r.path} -> ${r.loc}`).join(", "));
    console.log("!! An expired WAISHA_PROBE_TOKEN does this. Re-mint it and re-run; " +
      "a sweep that measured the login page is not a clean sweep.");
  }
  cdp.close();
  stop();
  // A faint sentence is a failure of the same kind as a page that never rendered: the
  // words are there and nobody can read them. Asked for, it stops the run.
  process.exit(movedPages.length || (CONTRAST && faint.length) ? 1 : 0);
}

main().catch((e) => { console.error(e.message); stop(); process.exit(1); });
