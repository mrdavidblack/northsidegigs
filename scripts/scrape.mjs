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
  /https?:\/\/(?:www\.)?eventbrite\.com\.au\/e\/[^"'\s<>?#]+/gi,
  /https?:\/\/[a-z0-9-]+\.iwannaticket\.com\.au\/[^"'\s<>]*event[^"'\s<>]*/gi,
  /https?:\/\/[a-z0-9-]+\.oztix\.com\.au\/Default\.aspx\?Event=\d+/gi,          // legacy Oztix outlets (The Last Chance)
  /\/Default\.aspx\?Event=\d+/gi
];

// A gig that runs across several days (a festival, a residency weekend) keeps an "until" time.
// Anything that just finishes after midnight is not multi-day.
function asMultiDay(e) {
  if (!e.end) return e;
  const { end, ...rest } = e;
  const span = Date.parse(end) - Date.parse(e.start);
  return span >= 20 * 3600e3 && span <= 7 * 86400e3 ? { ...rest, until: end } : rest;
}

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
async function render(url, { clickText = null } = {}) {
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
    if (clickText) {
      // Some venues only list their first dozen gigs until you press a "Show more" button.
      const re = new RegExp(clickText, 'i');
      for (let i = 0; i < 25; i++) {
        const btn = page.locator('button, a').filter({ hasText: re }).first();
        if (!(await btn.count()) || !(await btn.isVisible().catch(() => false))) break;
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1200);
      }
    }
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
  const priceOf = (o) => parseFloat(o.lowPrice ?? o.price);
  // $0 offers next to paid ones are companion or access tickets, not a free gig.
  const paid = (list) => list.map(priceOf).filter((p) => !Number.isNaN(p) && p > 0);
  const anyPaid = paid(offers).length > 0;
  const prices = anyPaid ? paid(onSale) : (onSale.length ? onSale : offers).map(priceOf).filter((p) => !Number.isNaN(p));
  let status = 'unknown';
  if (offers.length && (anyPaid ? !paid(onSale).length : !onSale.length) && offers.some((o) => /SoldOut|OutOfStock/i.test(avail(o)))) status = 'soldout';
  else if (anyPaid ? paid(onSale).length : onSale.length) status = 'onsale';
  const minPrice = prices.length ? Math.min(...prices) : null;
  if (minPrice === 0) status = 'free';
  return {
    title: decode(ev.name),
    start: normaliseStart(ev.startDate),
    end: ev.endDate ? normaliseStart(ev.endDate) : undefined,
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
      let html = (v.render || v.loadMore) ? await render(page, { clickText: v.loadMore }) : await get(page);
      let found = findTicketLinks(html, page);
      if (!found.length && !v.render && !v.loadMore) {
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

// muzeek.ai event widget (Punters Club). Paged JSON; most gigs are walk-in, so link to the venue's what's-on page.
async function muzeekStrategy(v) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const data = await get(`${v.pages[0]}?page=${page}&limit=50`, { json: true });
    for (const e of data.data ?? []) {
      const local = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(e.startDate));
      const tba = e.isAllDay || local === '00:00';
      const lineup = (e.performers ?? []).map((p) => p.name || p.title).filter(Boolean);
      out.push({
        title: decode(e.title),
        start: tba ? melbourneToIso(new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(e.startDate)), '00:00') : new Date(e.startDate).toISOString(),
        ...(tba ? { timeTba: true } : {}),
        price: null,
        status: e.ticketMode === 'none' ? 'unknown' : 'onsale',
        url: e.ticketUrl || v.link || v.pages[0],
        linkType: e.ticketUrl ? 'tickets' : 'details',
        ...(lineup.length ? { lineup } : {})
      });
    }
    if (!data.meta || page * 50 >= (data.meta.total ?? 0)) break;
  }
  return out;
}

const MONTH_NUM = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

function tidyCaps(t) {
  const x = String(t).trim();
  if (x.length < 4 || x !== x.toUpperCase() || !/[A-Z]/.test(x)) return x;
  return x.split(/(\s+)/).map((w) => {
    // Short words with no vowels (TTTDC, KTV) are band initials: leave them in capitals.
    const core = w.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '');
    if (/^[A-Z0-9]{2,6}$/.test(core) && !/[AEIOUY]/.test(core)) return w;
    return w.toLowerCase().replace(/(^|[&+(/'"-])([a-z])/g, (m, p1, c) => p1 + c.toUpperCase());
  }).join('');
}

// Bar Oussou: their own JSON feed. Only one-off gigs; the weekly open mic and spoken word nights are skipped.
async function baroussouStrategy(v) {
  const data = await get(v.pages[0], { json: true });
  return (data.items ?? []).filter((i) => i.eventCategory === 'gig' && i.eventDate).map((i) => {
    const [d, m, y] = i.eventDate.split('/');
    const hhmm = /^\d{1,2}:\d{2}$/.test(i.eventTime ?? '') ? i.eventTime.padStart(5, '0') : null;
    const price = parseFloat(String(i.ticketPrice ?? '').replace(/[^0-9.]/g, ''));
    return {
      title: decode(i.artistName),
      start: melbourneToIso(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`, hhmm ?? '00:00'),
      ...(hhmm ? {} : { timeTba: true }),
      price: Number.isNaN(price) ? null : price,
      status: i.isTicketed ? 'onsale' : 'unknown',
      url: `https://events.baroussou.com.au/${i.slug}`,
      linkType: 'details'
    };
  });
}

// What's Lively venue pages (Next.js): the gigs are embedded in the page as JSON (__NEXT_DATA__ > venueEvents).
// Each event has an ISO start time (UTC), a name with " • " between acts, a price range and a ticket link.
async function whatslivelyStrategy(v) {
  const html = await get(v.pages[0]);
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no __NEXT_DATA__ on page');
  const events = JSON.parse(m[1])?.props?.pageProps?.venueEvents;
  if (!Array.isArray(events)) throw new Error('no venueEvents array');
  return events.filter((e) => e.date && e.name).map((e) => {
    const title = decode(String(e.name)).replace(/\s*•\s*more\s*$/i, '').replace(/\s*•\s*/g, ', ').trim();
    const ticket = e.ticket?.url && /^https?:\/\//.test(e.ticket.url) ? e.ticket.url : null;
    const min = Number(e.price_range?.min);
    return {
      title,
      start: new Date(e.date).toISOString(),
      // A listed $0 is ambiguous (free entry or no price loaded), so it is left blank rather than shown as free.
      price: Number.isFinite(min) && min > 0 ? min : null,
      status: ticket ? 'onsale' : 'unknown',
      url: ticket ?? v.pages[0],
      linkType: ticket ? 'tickets' : 'details'
    };
  });
}

// Some venues list dates with no year ("November 10", "Friday 13th Nov"). Use the next occurrence,
// allowing a few weeks back so a gig earlier today or just gone is not pushed a year ahead.
function yearForDate(mon, day) {
  const today = new Date(`${todayMelb}T00:00:00Z`);
  const year = today.getUTCFullYear();
  return Date.UTC(year, mon - 1, day) < today.getTime() - 30 * 86400e3 ? year + 1 : year;
}

// The Drunken Poet gig guide (WordPress): one block per gig with .gig-heading (act) and .gig-date
// ("November 10 @ 8:00 pm", no year). Every gig is free entry and there are no per-gig links.
async function drunkenpoetStrategy(v) {
  const $ = cheerio.load(await get(v.pages[0]));
  const out = [];
  $('.gig-heading').each((_, el) => {
    const box = $(el).parent();
    const title = decode($(el).text()).replace(/\s+/g, ' ').trim();
    const raw = box.find('.gig-date').first().text().replace(/\s+/g, ' ').trim();
    const m = raw.match(/^([A-Za-z]+)\s+(\d{1,2})(?:\s*@\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm))?/i);
    const mon = m && MONTH_NUM[m[1].slice(0, 3).toUpperCase()];
    if (!title || !m || !mon) return;
    const year = yearForDate(mon, +m[2]);
    const date = `${year}-${String(mon).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
    let hhmm = null;
    if (m[3]) {
      let h = +m[3] % 12;
      if (m[5].toLowerCase() === 'pm') h += 12;
      hhmm = `${String(h).padStart(2, '0')}:${m[4] ?? '00'}`;
    }
    out.push({
      title,
      start: melbourneToIso(date, hhmm ?? '00:00'),
      ...(hhmm ? {} : { timeTba: true }),
      price: null,
      status: 'free',
      url: v.pages[0],
      linkType: 'details'
    });
  });
  return out;
}

// The Thornbury Local "What's On" page (WordPress/Elementor): each upcoming gig is a block with a heading
// (act) and a leaf line like "Friday 13th Nov, 8pm". The act's own social link is not a ticket page, so
// every gig links to the venue's What's On page. Entry is not stated on the page, so price is left blank.
async function thornburylocalStrategy(v) {
  const $ = cheerio.load(await get(v.pages[0]));
  const dateRe = /^(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\s+(\d{1,2})(?:st|nd|rd|th)\s+([A-Za-z]{3})[a-z]*,?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;
  const out = [];
  $('*').each((_, el) => {
    if ($(el).children().length) return;
    const m = $(el).text().replace(/\s+/g, ' ').trim().match(dateRe);
    const mon = m && MONTH_NUM[m[2].toUpperCase()];
    if (!mon) return;
    // The date line can itself be a heading, so look for the nearest enclosing block with a different heading.
    const isAct = (_, h) => { const t = decode($(h).text()); return t && !dateRe.test(t) && !/^what.s on$|^upcoming gigs$/i.test(t); };
    let box = $(el);
    for (let i = 0; i < 6; i++) { box = box.parent(); if (box.find('h1, h2, h3').filter(isAct).length) break; }
    const title = decode(box.find('h1, h2, h3').filter(isAct).first().text());
    if (!title) return;
    let h = +m[3] % 12;
    if (m[5].toLowerCase() === 'pm') h += 12;
    const year = yearForDate(mon, +m[1]);
    out.push({
      title,
      start: melbourneToIso(`${year}-${String(mon).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`, `${String(h).padStart(2, '0')}:${m[4] ?? '00'}`),
      price: null,
      status: 'unknown',
      url: v.pages[0],
      linkType: 'details'
    });
  });
  return out;
}

// Desert Highways record store: free in-store gigs listed as text blocks:
//   TITLE LINES / "SAT 31 OCT 2026" / "2PM - FREE - ALL AGES" / "FB EVENT"
// Gigs at other venues show a venue name instead of a time, so they are skipped (those venues list them).
async function deserthighwaysStrategy(v) {
  const $ = cheerio.load(await get(v.pages[0]));
  $('script, style, noscript').remove();
  $('br').replaceWith('\n');
  $('p, h1, h2, h3, h4, h5, li, div, tr, td, a').append('\n');
  const lines = $('body').text().split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const stop = lines.findIndex((l) => /^PAST\b/i.test(l));
  const L = stop >= 0 ? lines.slice(0, stop) : lines;
  const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const dateRe = /^(MON|TUE|WED|THU|FRI|SAT|SUN)[A-Z]*\.?,?\s+(?:(\d{1,2})\s+([A-Z]{3})[A-Z]*|([A-Z]{3})[A-Z]*\s+(\d{1,2}))\s+(\d{4})$/i;
  const out = [];
  let buf = [];
  for (let i = 0; i < L.length; i++) {
    const line = L[i];
    if (/^FB EVENT$/i.test(line) || /^UPCOMING\b/i.test(line)) { buf = []; continue; }
    const m = line.match(dateRe);
    if (!m) { buf.push(line); continue; }
    const titleLines = buf.filter((b) => !/^UPCOMING/i.test(b));
    buf = [];
    const next = L[i + 1] ?? '';
    const tm = next.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i);
    if (!tm || !titleLines.length) continue;
    let day, mon, year = parseInt(m[6], 10);
    if (m[2]) { day = parseInt(m[2], 10); mon = MONTH_NUM[m[3].toUpperCase()]; } else { mon = MONTH_NUM[m[4].toUpperCase()]; day = parseInt(m[5], 10); }
    if (!mon) continue;
    const want = DOW.indexOf(m[1].slice(0, 3).toUpperCase());
    const fits = (y, mo) => { const d = new Date(Date.UTC(y, mo - 1, day)); return d.getUTCDate() === day && d.getUTCDay() === want; };
    if (!fits(year, mon)) {
      // The page has typos (it once said "SUN 01 OCT" for 1 November). Try the next few months for the weekday that fits.
      for (let k = 1; k <= 3; k++) { let mo = mon + k; let y = year; if (mo > 12) { mo -= 12; y++; } if (fits(y, mo)) { mon = mo; year = y; break; } }
    }
    let h = parseInt(tm[1], 10);
    if (/pm/i.test(tm[3]) && h < 12) h += 12;
    if (/am/i.test(tm[3]) && h === 12) h = 0;
    const date = `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const price = next.match(/\$(\d+(?:\.\d\d)?)/);
    out.push({
      title: titleLines.slice(0, 2).map(tidyCaps).join(' · '),
      start: melbourneToIso(date, `${String(h).padStart(2, '0')}:${tm[2] ?? '00'}`),
      price: price ? parseFloat(price[1]) : null,
      status: /\bfree\b/i.test(next) ? 'free' : 'unknown',
      url: v.pages[0],
      linkType: 'details'
    });
  }
  return out;
}

// Creature Bar: one calendar page with every month. Each gig reads: MONTH / day / weekday / time / title / price / "Read More".
// Match a gig title to its detail page by slug (e.g. "Creature Feature" -> /events/creature-feature/ or smash-creature-feature).
function creatureLink(title, hrefs, page) {
  const slug = title.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const uniq = [...new Set(hrefs)].filter((h) => /\/events\/[^/]+/.test(h));
  const last = (h) => new URL(h).pathname.split('/').filter(Boolean).pop();
  const hit = uniq.find((h) => last(h) === slug)
    ?? uniq.find((h) => slug && (last(h).startsWith(slug) || slug.startsWith(last(h)) || last(h).includes(slug)));
  return hit ?? page;
}

async function creatureStrategy(v) {
  const page = v.pages[0];
  const $ = cheerio.load(await get(page));
  $('script, style, noscript').remove();
  const hrefs = [];
  $('a').each((_, a) => { if (/read more/i.test($(a).text())) hrefs.push(new URL($(a).attr('href') ?? '', page).href); });
  $('br').replaceWith('\n');
  $('p, h1, h2, h3, h4, h5, li, div, tr, td, a, span, time').append('\n');
  const lines = $('body').text().split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
  const nowY = parseInt(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(new Date()), 10);
  const nowM = parseInt(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, month: 'numeric' }).format(new Date()), 10);
  const found = [];
  // rmBefore[i] = how many "Read More" lines come before line i, so a gig can be matched to its own link
  // even if the reader skipped some other gig.
  const rmBefore = []; let rmCount = 0;
  lines.forEach((l, i) => { rmBefore[i] = rmCount; if (/^read more$/i.test(l)) rmCount++; });
  let month = null; let lastDay = 0; let yearBump = 0;
  for (let i = 0; i < lines.length; i++) {
    const mi = MONTHS.indexOf(lines[i].toUpperCase());
    if (mi >= 0) { month = mi + 1; lastDay = 0; yearBump = 0; continue; }
    if (!month || !/^\d{1,2}$/.test(lines[i]) || !/^(MON|TUE|WED|THU|FRI|SAT|SUN)$/i.test(lines[i + 1] ?? '')) continue;
    // If a month heading is missing, a day number that goes backwards means the next month started.
    if (parseInt(lines[i], 10) < lastDay) { month = month === 12 ? 1 : month + 1; if (month === 1) yearBump++; }
    lastDay = parseInt(lines[i], 10);
    const tm = (lines[i + 2] ?? '').match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
    const title = lines[i + 3];
    if (!tm || !title) continue;
    let price = null; let free = false;
    for (let k = i + 4; k < Math.min(i + 8, lines.length) && !/^read more$/i.test(lines[k]); k++) {
      const pm = lines[k].match(/^\$(\d+(?:\.\d\d)?)/);
      if (pm) price = parseFloat(pm[1]);
      if (/^free( entry)?$/i.test(lines[k])) free = true;
    }
    let h = parseInt(tm[1], 10);
    if (/pm/i.test(tm[3]) && h < 12) h += 12;
    if (/am/i.test(tm[3]) && h === 12) h = 0;
    const year = (month < nowM - 1 ? nowY + 1 : nowY) + yearBump;
    found.push({
      title: decode(title),
      start: melbourneToIso(`${year}-${String(month).padStart(2, '0')}-${lines[i].padStart(2, '0')}`, `${String(h).padStart(2, '0')}:${tm[2] ?? '00'}`),
      price, status: free ? 'free' : (price ? 'onsale' : 'unknown'),
      linkType: 'details',
      url: hrefs.length === rmCount ? (hrefs[rmBefore[i]] ?? page) : creatureLink(title, hrefs, page)
    });
  }
  return found;
}

// The Lomond Hotel (Lowie Live): a plain event list, each gig linking to a page that usually carries an Eventbrite link.
async function lomondStrategy(v) {
  const page = v.pages[0];
  const $ = cheerio.load(await get(page));
  const re = /^(.*?)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})$/;
  const items = new Map();
  $('a[href^="/node/"]').each((_, el) => {
    const m = $(el).text().replace(/\s+/g, ' ').trim().match(re);
    if (!m) return;
    const mon = MONTH_NUM[m[2].slice(0, 3).toUpperCase()];
    items.set(new URL($(el).attr('href'), page).href, {
      title: m[1].replace(/^(Lowie Live|Lomond Acoustica)\s+presents\s+/i, '').trim(),
      date: `${m[4]}-${String(mon).padStart(2, '0')}-${m[3].padStart(2, '0')}`
    });
  });
  const out = [];
  for (const [url, it] of [...items].slice(0, 60)) {
    let ticket = null;
    try { ticket = findTicketLinks(await get(url), url)[0] ?? null; } catch { /* use the listing */ }
    if (ticket) {
      try {
        const t = await readTicketPage(ticket);
        if (t) {
          // Residency pages on Eventbrite are one recurring listing: the start is the first night, long past.
          // Trust the venue's own date and keep the ticket page's clock time.
          const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(t.start));
          if (localDate !== it.date) {
            const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t.start));
            t.start = melbourneToIso(it.date, hhmm);
            delete t.end; delete t.until;
          }
          out.push({ ...t, title: it.title || t.title }); continue;
        }
      } catch { /* fall through */ }
    }
    out.push({ title: it.title, start: melbourneToIso(it.date, '00:00'), timeTba: true, price: null, status: 'unknown', url, linkType: 'details' });
  }
  return out;
}

// Uptown Jazz Cafe: one page per month (jan.php ... dec.php), each a list of "Wednesday 04" / act-name pairs.
// Nothing marks the year, and months that have not been updated keep last year's listing, so a gig is only
// kept when its weekday matches the date in the year we expect. Music starts at 8pm (stated on the venue's own site).
async function uptownStrategy(v) {
  const base = v.pages[0].replace(/\/[^/]*$/, '/');
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const DOWS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const [ty, tm] = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(new Date()).split('-').map(Number);
  const out = [];
  for (let k = 0; k < 3; k++) {
    const m0 = tm - 1 + k;
    const year = ty + Math.floor(m0 / 12);
    const month = (m0 % 12) + 1;
    const url = `${base}${MON[month - 1]}.php`;
    let html;
    try { html = await get(url); } catch { continue; }
    const $ = cheerio.load(html);
    $('script, style, noscript').remove();
    $('br').replaceWith('\n');
    $('p, h1, h2, h3, h4, h5, li, div, tr, td, a, span').append('\n');
    const lines = $('body').text().replace(/\u00a0/g, ' ').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    let kept = 0; let stale = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+(\d{1,2})$/i);
      if (!m) continue;
      const day = parseInt(m[2], 10);
      const title = lines[i + 1];
      if (!title || /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+\d/i.test(title)) continue;
      if (DOWS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] !== m[1].toLowerCase()) { stale++; continue; }
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      out.push({ title, start: melbourneToIso(date, '20:00'), price: null, status: 'unknown', url, linkType: 'details' });
      kept++;
    }
    console.log(`  uptown ${MON[month - 1]}: ${kept} gigs${stale ? `, ${stale} skipped (weekday does not match ${year}, page not updated)` : ''}`);
  }
  return out;
}

const STRATEGIES = { thornburylocal: thornburylocalStrategy, drunkenpoet: drunkenpoetStrategy, whatslively: whatslivelyStrategy, uptown: uptownStrategy, creature: creatureStrategy, baroussou: baroussouStrategy, deserthighways: deserthighwaysStrategy, lomond: lomondStrategy, muzeek: muzeekStrategy, textlist: textlistStrategy, links: linksStrategy, jsonld: jsonldStrategy, squarespace: squarespaceStrategy, hex: hexStrategy };

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
    .map(asMultiDay)
    .filter((e) => { const s0 = Date.parse(e.start); const last = e.until ? Date.parse(e.until) : s0; return last >= startOfToday && s0 <= horizon; })
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
  .map((e, i) => ({ id: i + 1, ...e, url: e.url.replace(/&#160;|&nbsp;|\u00a0/g, '').trim().replace('//alternate.moshtix.com.au/', '//www.moshtix.com.au/') }));

await writeFile(new URL('../public/events.json', import.meta.url), JSON.stringify({ generatedAt: status.generatedAt, timezone: TZ, events: final }, null, 1));
await writeFile(new URL('../public/status.json', import.meta.url), JSON.stringify(status, null, 1));
if (browser) await browser.close();
console.log(`\nWrote ${final.length} gigs.`);
const empty = status.venues.filter((s) => !s.count || s.keptFromLastRun);
if (empty.length) console.log(`::warning::Venues with no fresh gigs: ${empty.map((s) => s.name).join(', ')}`);
