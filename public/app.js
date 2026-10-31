(function () {
  'use strict';
  var TZ = 'Australia/Melbourne';
  var dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
  var timeFmt = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
  var dayFmt = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
  var shortDayFmt = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric' });
  var weekdayFmt = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short' });

  var params = new URLSearchParams(location.search);
  var state = {
    range: params.get('when') || 'all',
    suburbs: (params.get('suburb') || '').split(',').filter(Boolean),
    sort: params.get('sort') || 'date'
  };
  var events = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function dayLabel(d) { return dayFmt.format(d).replace(',', ''); }
  function melbDate(iso) { return dateFmt.format(new Date(iso)); }
  function addDays(ymd, n) {
    var d = new Date(ymd + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function timeLabel(e) {
    if (e.timeTba) return 'TBA';
    return timeFmt.format(new Date(e.start)).replace(/\s/g, '').toLowerCase();
  }
  function noonIso(ymd) { return ymd + 'T02:00:00Z'; }

  var today = melbDate(new Date().toISOString());
  var tomorrow = addDays(today, 1);

  // A festival or residency that started before today but runs on still counts as on today.
  function lastDay(e) { return melbDate(e.until || e.start); }
  function effDate(e) { var d = melbDate(e.start); return d < today ? today : d; }

  function weekendDays() {
    var wd = weekdayFmt.format(new Date(noonIso(today)));
    var order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    var i = order.indexOf(wd);
    var start = i >= 4 ? today : addDays(today, 4 - i);
    var end = addDays(today, 6 - i);
    return [start, end];
  }

  function inRange(ymd) {
    if (state.range === 'tonight') return ymd === today;
    if (state.range === 'weekend') { var w = weekendDays(); return ymd >= w[0] && ymd <= w[1]; }
    if (state.range === 'week') return ymd <= addDays(today, 6);
    return true;
  }

  function dayTitle(ymd) {
    if (ymd === today) return 'Tonight';
    if (ymd === tomorrow) return 'Tomorrow';
    return dayLabel(new Date(noonIso(ymd)));
  }

  function pills(el, key, options, isOn) {
    el.innerHTML = options.map(function (o) {
      var on = isOn ? isOn(o[0]) : state[key] === o[0];
      return '<button type="button" class="pill" data-key="' + key + '" data-val="' + esc(o[0]) + '" aria-pressed="' + on + '">' + esc(o[1]) + '</button>';
    }).join('');
  }

  function gigRow(e) {
    var ymd = effDate(e);
    var when = state.sort === 'suburb' ? shortDayFmt.format(new Date(noonIso(ymd))).replace(',', '') + ' · ' + timeLabel(e) : timeLabel(e);
    var until = e.until && lastDay(e) > ymd ? '<span class="until">until ' + esc(dayLabel(new Date(noonIso(lastDay(e))))) + '</span>' : '';
    var maps = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(e.venue + ' ' + e.suburb + ' VIC');
    var price = '', cls = '';
    if (e.status === 'soldout') { price = 'Sold out'; cls = 'soldout'; }
    else if (e.status === 'free') { price = 'Free'; cls = 'free'; }
    else if (e.price) { price = '$' + e.price.toFixed(2); }
    var cta = e.linkType === 'tickets' ? (e.status === 'soldout' ? 'Waitlist' : 'Tickets') : 'Details';
    return '<article class="gig">' +
      '<div class="gig-time">' + esc(when) + until + '</div>' +
      '<div class="gig-main"><h3 class="gig-title">' + esc(e.title) + '</h3>' +
      '<p class="gig-venue"><a class="venue-link" href="' + esc(maps) + '" target="_blank" rel="noopener" aria-label="' + esc(e.venue + ' on Google Maps (opens in a new tab)') + '"><strong>' + esc(e.venue) + '</strong></a> · ' + esc(e.suburb) + '</p></div>' +
      '<div class="gig-act"><span class="price ' + cls + '">' + esc(price) + '</span>' +
      '<a class="btn" href="' + esc(e.url) + '" target="_blank" rel="noopener">' + cta +
      ' <span class="visually-hidden" style="position:absolute;left:-9999px">for ' + esc(e.title) + ' (opens in a new tab)</span>' +
      '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 10L10 4M5 4h5v5"/></svg></a></div>' +
      '</article>';
  }

  function render() {
    var upcoming = events.filter(function (e) { return lastDay(e) >= today; });
    var tonightN = upcoming.filter(function (e) { return effDate(e) === today; }).length;
    document.getElementById('tonight-count').textContent = tonightN + (tonightN === 1 ? ' gig tonight.' : ' gigs tonight.');
    document.getElementById('total-count').textContent = upcoming.length + ' coming up.';

    var suburbs = Array.from(new Set(upcoming.map(function (e) { return e.suburb; }))).sort();
    pills(document.getElementById('ranges'), 'range', [['all', 'All upcoming'], ['tonight', 'Tonight'], ['weekend', 'This weekend'], ['week', 'Next 7 days']]);
    // Drop any chosen suburb that no longer has gigs, so a stale link cannot hide everything.
    state.suburbs = state.suburbs.filter(function (s) { return suburbs.indexOf(s) >= 0; });
    pills(document.getElementById('suburbs'), 'suburbs', [['all', 'All']].concat(suburbs.map(function (s) { return [s, s]; })),
      function (v) { return v === 'all' ? state.suburbs.length === 0 : state.suburbs.indexOf(v) >= 0; });
    pills(document.getElementById('sorts'), 'sort', [['date', 'Date'], ['suburb', 'Suburb']]);

    var shown = upcoming.filter(function (e) {
      return inRange(effDate(e)) && (state.suburbs.length === 0 || state.suburbs.indexOf(e.suburb) >= 0);
    });

    // Header: what is selected, how many filters are on, and the button that closes the panel.
    var rangeNames = { all: 'All upcoming', tonight: 'Tonight', weekend: 'This weekend', week: 'Next 7 days' };
    var active = (state.range !== 'all' ? 1 : 0) + state.suburbs.length;
    document.getElementById('summary').textContent = rangeNames[state.range] + ' · ' + (state.suburbs.length ? state.suburbs.join(', ') : 'All suburbs');
    var badge = document.getElementById('filter-count');
    badge.textContent = active ? String(active) : '';
    badge.hidden = !active;
    document.getElementById('filter-done').textContent = 'Show ' + shown.length + (shown.length === 1 ? ' gig' : ' gigs');

    var list = document.getElementById('list');
    if (!shown.length) {
      list.innerHTML = '<div class="empty"><h2>Nothing on</h2><p>No gigs match those filters. Try a wider date range.</p>' +
        '<div><button type="button" class="pill" data-reset="1">Clear filters</button></div></div>';
      return;
    }

    var groups = [];
    var byKey = {};
    shown.forEach(function (e) {
      var k = state.sort === 'suburb' ? e.suburb : effDate(e);
      if (!byKey[k]) { byKey[k] = []; groups.push(k); }
      byKey[k].push(e);
    });
    if (state.sort === 'suburb') groups.sort();

    list.innerHTML = groups.map(function (k) {
      var items = byKey[k];
      var n = items.length + (items.length === 1 ? ' gig' : ' gigs');
      var title, sub, isToday = false;
      if (state.sort === 'suburb') { title = k; sub = n; }
      else {
        title = dayTitle(k);
        isToday = k === today;
        sub = (k === today || k === tomorrow ? dayLabel(new Date(noonIso(k))) + ' · ' : '') + n;
      }
      return '<section class="group"><div class="group-head"><h2' + (isToday ? ' class="is-today"' : '') + '>' + esc(title) + '</h2>' +
        '<span class="group-sub">' + esc(sub) + '</span></div>' + items.map(gigRow).join('') + '</section>';
    }).join('');
  }

  function syncUrl() {
    var p = new URLSearchParams();
    if (state.range !== 'all') p.set('when', state.range);
    if (state.suburbs.length) p.set('suburb', state.suburbs.join(','));
    if (state.sort !== 'date') p.set('sort', state.sort);
    var q = p.toString();
    history.replaceState(null, '', q ? '?' + q : location.pathname);
  }

  var panel = document.getElementById('filter-panel');
  var toggle = document.getElementById('filter-toggle');
  function setPanel(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  }

  document.addEventListener('click', function (ev) {
    if (ev.target.closest('#filter-toggle')) { setPanel(panel.hidden); return; }
    if (ev.target.closest('#filter-done')) { setPanel(false); window.scrollTo({ top: Math.max(0, document.getElementById('list').offsetTop - 80), behavior: 'smooth' }); return; }
    if (!panel.hidden && !ev.target.closest('#topbar')) setPanel(false);
    var b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.reset) { state = { range: 'all', suburbs: [], sort: 'date' }; }
    else if (b.dataset.key === 'suburbs') {
      // Suburbs combine: tap to add or remove; All clears the selection.
      var v = b.dataset.val;
      if (v === 'all') state.suburbs = [];
      else {
        var i = state.suburbs.indexOf(v);
        if (i >= 0) state.suburbs.splice(i, 1); else state.suburbs.push(v);
      }
    }
    else if (b.dataset.key) { state[b.dataset.key] = b.dataset.val; }
    else return;
    syncUrl();
    render();
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !panel.hidden) { setPanel(false); toggle.focus(); }
  });

  // Build the contact link in the browser so the address is not sitting in the page for spam bots.
  var c = document.getElementById('contact');
  if (c) { var addr = c.dataset.u + '@' + c.dataset.d; c.href = 'mailto:' + addr + '?subject=' + encodeURIComponent('Northside Gigs: missing gig or venue'); }

  fetch('/events.json', { cache: 'no-cache' })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      events = (data.events || []).slice().sort(function (a, b) { return Date.parse(a.start) - Date.parse(b.start); });
      if (data.generatedAt) {
        var d = new Date(data.generatedAt);
        document.getElementById('updated').textContent = 'Last updated ' + dayLabel(d) + ', ' + timeFmt.format(d).replace(/\s/g, '').toLowerCase() + '.';
      }
      render();
    })
    .catch(function (err) {
      console.error('Gig list error', err);
      document.getElementById('list').innerHTML = '<p class="loading">Couldn’t load the gig list. Try refreshing.</p>';
    });
})();
