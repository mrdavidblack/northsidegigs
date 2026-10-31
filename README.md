# Northside Gigs

Gig guide for band rooms and small venues in Melbourne's inner north.

- `public/` is the whole website: `index.html`, `styles.css`, `app.js`, and `events.json` (the gig list).
- `venues.json` lists the venues and how to read each one.
- `scripts/scrape.mjs` reads every venue and rewrites `public/events.json` and `public/status.json`.
- `.github/workflows/scrape.yml` runs the scraper twice a day (about 6am and 4pm Melbourne time) and commits any changes. Vercel redeploys on every commit.

## Add a venue

Add an entry to `venues.json`:

```json
{ "id": "newvenue", "name": "The New Venue", "suburb": "Brunswick", "strategy": "links", "pages": ["https://example.com/gigs"] }
```

Strategies:

- `links`: finds ticket links (Oztix, Moshtix, Humanitix, TryBooking, iwannaticket) on the listed pages, then reads the start time and price from each ticket page. Add `"follow": "regex"` if the venue lists gigs on its own event pages first.
- `jsonld`: the listing page already carries event data (Moshtix venue pages, The Jazzlab).
- `squarespace`: Squarespace event collections (Nighthawks, Edinburgh Castle).
- `hex`: The Hex's own site.

Add `"exclude": "trivia|quiz"` to skip non-gig events at that venue.

Then run it for just that venue: `node scripts/scrape.mjs newvenue`, or from GitHub: Actions › Update gigs › Run workflow, with the venue id.

## Checking it is working

`public/status.json` shows how many gigs each venue returned on the last run. A venue that returns nothing keeps its previous gigs and is flagged as a warning in the Action log.

## Run locally

```
npm ci
npm run scrape
npx serve public
```
