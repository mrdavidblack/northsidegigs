// After each scrape: if any venue returned no fresh gigs, open (or update) one GitHub issue listing them.
// GitHub emails the repo owner about new issues and comments. When everything is working again, the issue is closed.

import { readFile } from 'node:fs/promises';

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
if (!token || !repo) { console.log('No GitHub token or repo, skipping report.'); process.exit(0); }

const LABEL = 'scraper-alert';
const api = async (path, opts = {}) => {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', ...(opts.headers || {}) }
  });
  if (!res.ok && res.status !== 422) throw new Error(`${res.status} ${path}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};

const status = JSON.parse(await readFile(new URL('../public/status.json', import.meta.url)));
const broken = status.venues.filter((v) => !v.count || v.keptFromLastRun || v.error);

const lines = broken.map((v) => {
  const why = v.error ? `error: ${v.error}`
    : v.keptFromLastRun ? `no fresh gigs, showing ${v.count} from the last good run`
    : 'no gigs found';
  const failed = v.debug?.failed?.length ? `\n  - failed requests: ${v.debug.failed.slice(0, 3).join(', ')}` : '';
  return `- **${v.name}** (\`${v.id}\`): ${why}${failed}`;
});
const signature = broken.map((v) => v.id).sort().join(',');

// Make sure the label exists (422 means it already does).
await api('/labels', { method: 'POST', body: JSON.stringify({ name: LABEL, color: 'd93f0b', description: 'A venue scraper needs attention' }) });

const open = await api(`/issues?state=open&labels=${LABEL}&per_page=5`);
const issue = open[0];

if (!broken.length) {
  if (issue) {
    await api(`/issues/${issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `All venues returned fresh gigs on the run at ${status.generatedAt}. Closing.` }) });
    await api(`/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
    console.log(`Closed issue #${issue.number}.`);
  } else console.log('All venues fine.');
  process.exit(0);
}

const body = `These venues returned no fresh gigs on the run at ${status.generatedAt}:\n\n${lines.join('\n')}\n\n` +
  'The site keeps showing each venue\'s last good gigs until it is fixed. Usual causes: the venue changed its website, moved its gig page, or changed ticketing company. ' +
  'Check the page in `venues.json`, then rerun just that venue from Actions › Update gigs › Run workflow.\n\n' +
  `<!-- signature:${signature} -->`;

if (!issue) {
  const created = await api('/issues', { method: 'POST', body: JSON.stringify({ title: `Venues need attention: ${broken.map((v) => v.name).join(', ')}`.slice(0, 200), body, labels: [LABEL] }) });
  console.log(`Opened issue #${created.number}.`);
} else if (!String(issue.body || '').includes(`<!-- signature:${signature} -->`)) {
  // The list of broken venues changed: update the issue and comment so an email goes out.
  await api(`/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ title: `Venues need attention: ${broken.map((v) => v.name).join(', ')}`.slice(0, 200), body }) });
  await api(`/issues/${issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `The list changed:\n\n${lines.join('\n')}` }) });
  console.log(`Updated issue #${issue.number}.`);
} else console.log(`Issue #${issue.number} already lists these venues.`);
