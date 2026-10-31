// Northside Gigs scraper.
// Reads venues.json, collects upcoming gigs for each venue, writes public/events.json and public/status.json.
// Run: node scripts/scrape.mjs            (all venues)
//      node scripts/scrape.mjs tote hex   (only these venue ids, for testing)

import { readFile, writeFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';

const TZ = 'Australia/Melbourne';
const DAYS_AHEAD = 60;
const UA = 'NorthsideGigsBot/0.1 (+https://northsidegigs.com; small community gig guide)';
const DELAY_MS = 400;

// Titles that are not gigs, at any venue.
const GLOBAL_EXCLUDE = /\b(trivia|pub quiz|quiz night|bingo|karaoke|wine tasting|wine walk|market|pop[- ]?up shop|footy ball|storyslam|parma|happy hour|function room)\b/i;

// Ticket pages we know how to read.
const TICKET_PATTERNS = [
  /https?:\/\/[^"'\s<>]+\/outlet\/event\/[0-9a-f-]{36}/gi,        // Oztix, including white-label domains
  /https?:\/\/(?:www\.)?moshtix\.com\.au\/v2\/event\/[^"'\s<>?#]+\/\d+/gi,
  /https?:\/\/events\.humanitix\.com\/[a-z0-9-]+/gi,
  /https?:\/\/(?:www\.)?trybooking\.com\/[A-Z0-9]{4,6}\b/g,
  /https?:\/\/[a-z0-9-]+\.iwannaticket\.com\.au\/[^"'\s<>]*event[^"'\s<>]*/gi,
  /https?:\/\/[a-z0-9-]+\.oztix\.com\.au\/Default\.aspx\?Event=\d+/gi,          // legacy Oztix outlets (The Last Chance)
  /\/Default\.aspx\?Event=\d+/gi
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
let diag = null; // per-venue diagnostics, reset for each venue

async function get(url, { json = false } = {}) {
  const headers = (ua) => ({ 'user-agent': ua, accept: json ? 'application/json' : 'text/html,application/xhtml+xml,*/*', 'accept-language': 'en-AU,en;q=0.9' });
  let res = await fetch(url, { headers: headers(UA), redirect: 'follow' });
  if (res.status === 403 || res.status === 429) { await sleep(1500); res = await fetch(url, { headers: headers(BROWSER_UA), redirect: 'follow' }); }
  if (res.status === 403 && /\/\/www\.moshtix\.com\.au\//.test(url)) {
    const alt = url.replace('//www.moshtix.com.au/', '//alternate.moshtix.com.au/');
    res = await fetch(alt, { headers: headers(BROWSER_UA), redirect: 'follow' });
    if (diag) diag.fetches.push(`${res.status} (alt) ${alt.slice(0, 80)}`);
  }
  await sleep(DELAY_MS);
  if (diag) diag.fetches.push(`${res.status} ${url.slice(0, 90)}`);
  if (!res.ok) {
    if (!json && res.status === 403) {
      const html = await render(url).catch(() => null);
      if (html && html.length > 2000) return html;
    }
    throw new Error(`${res.status} ${url}`);
  }
  return json ? res.json() : res.text();
}

// Headless Chrome, for listing pages built with JavaScript and for sites that block plain requests.
let browser = null;
async function render(url) {
  if (!browser) {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
  }
  const ctx = await browser.newContext({ userAgent: BROWSER_UA, locale: 'en-AU', timezoneId: TZ });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(1500);
    let html = await page.content();
    // Include iframes (some venues embed their ticketing widget).
    for (const f of page.frames().slice(1, 6)) { try { html += await f.content(); } catch { /* cross-origin */ } }
    if (diag) diag.fetches.push(`200 (rendered) ${url.slice(0, 80)}`);
    return html;
  } finally { await ctx.close(); }
}

const decode = (s) => cheerio.load(`<i>${s ?? ''}</i>`)('i').text().replace(/\s+/g, ' ').trim();

function ldBlocks(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const j = JSON.parse($(el).contents().text());
      for (const item of [].concat(j)) out.push(...[].concat(item['@graph'] ?? item));
    } catch { /* ignore broken blocks */ }
  });
  return out;
}

const isEvent = (x) => x && x.startDate && /Event/i.test([].concat(x['@type'] ?? '').join(' '));

// Turn one schema.org Event (plus any loose Offer blocks on the page) into our shape.
function fromLd(ev, looseOffers = [], fallbackUrl) {
  const offers = [].concat(ev.offers ?? []).flatMap((o) => (o['@type'] === 'AggregateOffer' && o.offers ? [].concat(o.offers) : [o])).concat(looseOffers);
  const avail = (o) => String(o.availability ?? '');
  const onSale = offers.filter((o) => /InStock|LimitedAvailability|PreOrder/i.test(avail(o)));
  const prices = (onSale.length ? onSale : offers).map((o) => parseFloat(o.lowPrice ?? o.price)).filter((p) => !Number.isNaN(p));
  let status = 'unknown';
  if (offers.length && !onSale.length && offers.some((o) => /SoldOut|OutOfStock/i.test(avail(o)))) status = 'soldout';
  else if (onSale.length) status = 'onsale';
  const minPrice = prices.length ? Math.min(...prices) : null;
  if (minPrice === 0) status = 'free';
  return {
    title: decode(ev.name),
    start: normaliseStart(ev.startDate),
    price: minPrice && minPrice > 0 ? Math.round(minPrice * 100) / 100 : null,
    status,
    url: ev.url && /^https?:/.test(ev.url) ? ev.url : fallbackUrl,
    linkType: 'tickets'
  };
}

// Dates without an offset are Melbourne local time. Keep them as local ISO strings with the right offset.
function normaliseStart(s) {
  if (!s) return null;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) return new Date(s).toISOString();
  const [d, t = '00:00:00'] = s.split('T');
  return melbourneToIso(d, t.slice(0, 5));
}

function melbourneOffset(dateStr) {
  // Find Melbourne's UTC offset on that date (AEST +10 or AEDT +11).
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, timeZoneName: 'shortOffset' }).formatToParts(probe);
  const off = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+10';
  const h = parseInt(off.replace('GMT', ''), 10) || 10;
  return h;
}

function melbourneToIso(dateStr, hhmm) {
  const h = melbourneOffset(dateStr);
  const local = new Date(`${dateStr}T${hhmm}:00Z`);
  return new Date(local.getTime() - h * 3600 * 1000).toISOString();
}

function findTicketLinks(html, base) {
  const found = new Set();
  const $ = cheerio.load(html);
  const hrefs = [];
  $('a[href], iframe[src]').each((_, el) => hrefs.push($(el).attr('href') || $(el).attr('src')));
  const text = hrefs.map((h) => { try { return new URL(h, base).href; } catch { return ''; } }).join('\n') + '\n' + html;
  for (const re of TICKET_PATTERNS) for (const m of text.matchAll(re)) {
    let u = m[0].replace(/&amp;/g, '&').replace(/[).,;]+$/, '');
    try { u = new URL(u, base).href; } catch { continue; }
    found.add(u);
  }
  return [...found];
}

async function readTicketPage(url) {
  let html = await get(url);
  let blocks = ldBlocks(html);
  if (!blocks.some(isEvent) && /Default\.aspx\?Event=/i.test(url)) {
    // Legacy Oztix link: find the new event page it points to and read that.
    const m = html.match(/https?:\/\/[a-z0-9.-]+\/outlet\/event\/[0-9a-f-]{36}/i) || html.match(/\/outlet\/event\/[0-9a-f-]{36}/i);
    if (m) { url = new URL(m[0], url).href; html = await get(url); blocks = ldBlocks(html); }
  }
  if (!blocks.some(isEvent)) {
    // Some ticket pages only add their event data with JavaScript.
    try { html = await render(url); blocks = ldBlocks(html); } catch { /* give up on this one */ }
  }
  const ev = blocks.find(isEvent);
  if (!ev) return null;
  const loose = blocks.filter((b) => b['@type'] === 'Offer');
  return fromLd(ev, loose, url);
}

// ---- strategies ----

async function linksStrategy(v) {
  let links = [];
  for (const page of v.pages) {
    try {
      let html = v.render ? await render(page) : await get(page);
      let found = findTicketLinks(html, page);
      if (!found.length && !v.render) {
        try { html = await render(page); found = findTicketLinks(html, page); } catch (e) { console.warn(`  render failed ${page}: ${e.message}`); }
      }
      links.push(...found);
      if (v.follow) {
        const re = new RegExp(v.follow);
        const $ = cheerio.load(html);
        const inner = new Set();
        $('a[href]').each((_, el) => { const h = $(el).attr('href'); if (re.test(h)) inner.add(new URL(h, page).href); });
        for (const p of [...inner].slice(0, 40)) {
          try { links.push(...findTicketLinks(await get(p), p)); } catch (e) { console.warn(`  follow failed ${p}: ${e.message}`); }
        }
      }
    } catch (e) { console.warn(`  page failed ${page}: ${e.message}`); }
  }
  // Oztix white-label and generic URLs for the same event: keep one per event id.
  const seen = new Set();
  links = links.filter((l) => { const k = (l.match(/[0-9a-f-]{36}|\/\d+$/i) || [l])[0]; if (seen.has(k)) return false; seen.add(k); return true; });
  if (diag) diag.ticketLinks = links.length;
  const out = [];
  for (const l of links.slice(0, 80)) {
    try { const e = await readTicketPage(l); if (e) out.push(e); else if (diag) diag.noEventData.push(l.slice(0, 90)); } catch (err) { console.warn(`  ticket page failed ${l}: ${err.message}`); }
  }
  return out;
}

async function jsonldStrategy(v) {
  const out = [];
  for (const page of v.pages) {
    const html = await get(page);
    for (const ev of ldBlocks(html).filter(isEvent)) out.push(fromLd(ev, [], page));
  }
  return out;
}

async function squarespaceStrategy(v) {
  const out = [];
  for (const page of v.pages) {
    const u = new URL(page);
    const data = await get(`${page}?format=json`, { json: true });
    const items = data.upcoming ?? data.items ?? [];
    for (const it of items) {
      const detailUrl = new URL(it.fullUrl, u.origin).href;
      let ticket = findTicketLinks(it.body ?? '', detailUrl)[0];
      if (!ticket) {
        try { ticket = findTicketLinks(await get(detailUrl), detailUrl)[0]; } catch { /* keep detail page */ }
      }
      let price = null; let status = 'unknown';
      if (ticket) {
        try { const t = await readTicketPage(ticket); if (t) { price = t.price; status = t.status; } } catch { /* fine */ }
      }
      const body = decode(it.body ?? '') + ' ' + decode(it.excerpt ?? '');
      if (!ticket && /free entry|free gig|\bfree\b/i.test(body)) status = 'free';
      out.push({
        title: decode(it.title),
        start: new Date(it.startDate).toISOString(),
        price, status,
        url: ticket ?? detailUrl,
        linkType: ticket ? 'tickets' : 'details'
      });
    }
  }
  return out;
}

async function hexStrategy(v) {
  const html = await get(v.pages[0]);
  const $ = cheerio.load(html);
  const pages = new Set();
  $('a[href]').each((_, el) => { const h = $(el).attr('href'); if (/\?\d{8}_/.test(h)) pages.add(new URL(h, v.pages[0]).href); });
  const out = [];
  for (const p of pages) {
    const ymd = p.match(/\?(\d{4})(\d{2})(\d{2})_/);
    if (!ymd) continue;
    const page = cheerio.load(await get(p));
    const text = page('body').text().replace(/\s+/g, ' ');
    const title = page('title').text().split('|')[0].trim();
    const tm = text.match(/(?:doors|start[s]?|from)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/i);
    let hhmm = null;
    if (tm) { let h = parseInt(tm[1], 10); if (!tm[3] || /pm/i.test(tm[3])) { if (h < 12) h += 12; } hhmm = `${String(h).padStart(2, '0')}:${tm[2] ?? '00'}`; }
    const date = `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
    const ticket = findTicketLinks(page.html(), p)[0];
    const pm = text.match(/\$(\d+(?:\.\d\d)?)/);
    out.push({
      title,
      start: melbourneToIso(date, hhmm ?? '00:00'),
      timeTba: !hhmm,
      price: pm ? parseFloat(pm[1]) : null,
      status: /free entry/i.test(text) ? 'free' : (ticket ? 'onsale' : 'unknown'),
      url: ticket ?? p,
      linkType: ticket ? 'tickets' : 'details'
    });
  }
  return out;
}

// Plain text gig list: month headings, then lines like "31 - BAND NAME + SUPPORT FROM 8PM".
async function textlistStrategy(v) {
  const MONTHS = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
  const out = [];
  for (const page of v.pages) {
    const $ = cheerio.load(await get(page));
    $('br').replaceWith('\n');
    $('p, h1, h2, h3, h4, li, div').append('\n');
    const lines = $('body').text().split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const nowY = parseInt(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(new Date()), 10);
    const nowM = parseInt(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, month: 'numeric' }).format(new Date()), 10);
    let month = null;
    const seen = new Set();
    for (const line of lines) {
      const mi = MONTHS.indexOf(line.toUpperCase().replace(/[^A-Z]/g, ''));
      if (mi >= 0) { month = mi + 1; continue; }
      const m = line.match(/^(\d{1,2})\s*[-–—]\s*(.+?)(?:\s+from\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm))?\s*$/i);
      if (!m || !month) continue;
      let h = m[3] ? parseInt(m[3], 10) : null;
      if (h !== null && (!m[5] || /pm/i.test(m[5])) && h < 12) h += 12;
      const year = month < nowM - 1 ? nowY + 1 : nowY;
      const date = `${year}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      const title = m[2].replace(/!+/g, '!').trim();
      const key = date + title;
      if (seen.has(key)) continue; seen.add(key);
      out.push({
        title: title.length > 4 && title === title.toUpperCase() ? title.toLowerCase().replace(/(^|[\s&+(/-])([a-z])/g, (a, b, c) => b + c.toUpperCase()) : title,
        start: melbourneToIso(date, h === null ? '00:00' : `${String(h).padStart(2, '0')}:${m[4] ?? '00'}`),
        timeTba: h === null,
        price: null,
        status: /free/i.test(title) ? 'free' : 'unknown',
        url: page,
        linkType: 'details'
      });
    }
  }
  return out;
}

const STRATEGIES = { textlist: textlistStrategy, links: linksStrategy, jsonld: jsonldStrategy, squarespace: squarespaceStrategy, hex: hexStrategy };

// ---- main ----

const { venues } = JSON.parse(await readFile(new URL('../venues.json', import.meta.url)));
const only = process.argv.slice(2);
let previous = { events: [] };
try { previous = JSON.parse(await readFile(new URL('../public/events.json', import.meta.url))); } catch { /* first run */ }
let previousStatus = { venues: [] };
try { previousStatus = JSON.parse(await readFile(new URL('../public/status.json', import.meta.url))); } catch { /* first run */ }

const now = Date.now();
const todayMelb = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); // YYYY-MM-DD
const startOfToday = Date.parse(melbourneToIso(todayMelb, '00:00'));
const horizon = now + DAYS_AHEAD * 86400 * 1000;

const all = [];
const status = { generatedAt: new Date().toISOString(), venues: [] };

for (const v of venues) {
  if (only.length && !only.includes(v.id)) {
    all.push(...previous.events.filter((e) => e.venueId === v.id));
    const ps = previousStatus.venues.find((x) => x.id === v.id);
    if (ps) status.venues.push(ps);
    continue;
  }
  console.log(`> ${v.name}`);
  diag = { fetches: [], ticketLinks: null, noEventData: [] };
  const exclude = v.exclude ? new RegExp(v.exclude, 'i') : null;
  let events = [];
  let error = null;
  try { events = await STRATEGIES[v.strategy](v); } catch (e) { error = e.message; console.warn(`  FAILED: ${e.message}`); }
  events = events
    .filter((e) => e && e.title && e.start)
    .filter((e) => { const t = Date.parse(e.start); return t >= startOfToday && t <= horizon; })
    .filter((e) => !GLOBAL_EXCLUDE.test(e.title) && !(exclude && exclude.test(e.title)))
    .map((e) => ({ ...e, venueId: v.id, venue: v.name, suburb: v.suburb }));

  // A venue that suddenly returns nothing keeps its previous future gigs, so one broken scraper does not empty the site.
  let kept = false;
  if (!events.length) {
    const prev = previous.events.filter((e) => e.venueId === v.id && Date.parse(e.start) >= startOfToday);
    if (prev.length) { events = prev; kept = true; }
  }
  console.log(`  ${events.length} gigs${kept ? ' (kept from last run)' : ''}`);
  const fails = diag.fetches.filter((f) => !f.startsWith('200'));
  status.venues.push({ id: v.id, name: v.name, count: events.length, keptFromLastRun: kept, error,
    debug: { fetched: diag.fetches.length, failed: fails.slice(0, 5), ticketLinks: diag.ticketLinks, noEventData: diag.noEventData.slice(0, 3), firstFetches: diag.fetches.slice(0, 3) } });
  all.push(...events);
}

// Dedupe by url, sort by start.
const seen = new Set();
const final = all
  .filter((e) => { if (seen.has(e.url + e.start)) return false; seen.add(e.url + e.start); return true; })
  .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.venue.localeCompare(b.venue))
  .map((e, i) => ({ id: i + 1, ...e }));

await writeFile(new URL('../public/events.json', import.meta.url), JSON.stringify({ generatedAt: status.generatedAt, timezone: TZ, events: final }, null, 1));
await writeFile(new URL('../public/status.json', import.meta.url), JSON.stringify(status, null, 1));
if (browser) await browser.close();
console.log(`\nWrote ${final.length} gigs.`);
const empty = status.venues.filter((s) => !s.count || s.keptFromLastRun);
if (empty.length) console.log(`::warning::Venues with no fresh gigs: ${empty.map((s) => s.name).join(', ')}`);
