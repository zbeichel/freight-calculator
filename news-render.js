// news-render.js — Market News: a week's update (a market_updates row) as HTML.
// One copy for both sides: the page (market-news.html) runs it in the browser, and the server
// (netlify/functions/news-page.js) runs it to send each week's page with the update already in
// it, so search engines read the update without running the page's script.
// Text from the weekly task is escaped, with **bold** as the only markup.
(function (root) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const safeUrl = (u) => { try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.href : null; } catch (e) { return null; } };
  const link = (u, text) => { const h = safeUrl(u); return h ? `<a href="${esc(h)}" target="_blank" rel="noopener noreferrer nofollow">${text}</a>` : text; };
  // A date at noon, so it's the same day in every U.S. time zone (and on the server)
  const day = (iso, opts) => { const d = new Date(String(iso).slice(0, 10) + 'T12:00:00'); return isNaN(d) ? '' : d.toLocaleDateString('en-US', opts || { month: 'long', day: 'numeric', year: 'numeric' }); };
  const arr = (x) => (Array.isArray(x) ? x : []);
  const SHORT = { month: 'short', day: 'numeric', year: 'numeric' };

  // Each week has its own page: /market-news/2026-11-09. The main page and each week's page
  // list the newest RECENT weeks; every week is on the archive page.
  const RECENT = 8;
  const ARCHIVE_URL = '/market-news/archive';
  const isWeek = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(String(s) + 'T12:00:00Z'));
  const weekUrl = (w) => '/market-news/' + encodeURIComponent(String(w).slice(0, 10));
  // Plain text (no **bold**), and cut at a word for a page description
  const plain = (s) => String(s == null ? '' : s).replace(/\*\*(.+?)\*\*/g, '$1').replace(/\s+/g, ' ').trim();
  function clip(s, n) {
    const t = plain(s);
    if (t.length <= n) return t;
    const cut = t.slice(0, n - 1);
    const at = cut.lastIndexOf(' ');
    return (at > n * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.–—-]+$/, '') + '…';
  }

  // The page's main heading: this week on the main page, the week's date on its own page
  const heading = (u, ownPage) => (ownPage && u
    ? `Freight news, <em>week of ${esc(day(u.week_of, SHORT))}</em>`
    : 'This week in <em>freight</em>');

  // The update itself. opt.admin: the owner's Draft/Published bar; opt.permalink: the week's
  // date links to the week's own page (on the main page); opt.notice: oldNotice().
  function postHTML(u, opt) {
    opt = opt || {};
    const draft = u.status === 'draft';
    const glance = arr(u.glance);
    const items = arr(u.items);
    const heads = arr(u.headlines);
    const sources = arr(u.sources);
    const bar = opt.admin
      ? (draft
        ? `<div class="news-draft"><span><strong>Draft.</strong> Only you can see this until you publish it.</span><span class="btns"><button type="button" class="btn btn-primary" data-act="publish" data-id="${esc(u.id)}">Publish</button></span></div>`
        : `<div class="news-draft live"><span><strong>Published</strong>${u.published_at ? ' ' + esc(day(u.published_at, { month: 'short', day: 'numeric' })) : ''}. Everyone can see this.</span><span class="btns"><button type="button" class="btn btn-ghost" data-act="unpublish" data-id="${esc(u.id)}">Unpublish</button></span></div>`)
      : '';
    const glanceHTML = glance.length ? `<section class="news-sec"><h3 class="news-h">This week at a glance</h3>
      <div class="log-wrap news-glance"><table><thead><tr><th>Measure</th><th class="num">Now</th><th class="num">vs last week</th><th class="num">vs last year</th></tr></thead><tbody>
      ${glance.map((g) => `<tr><td>${rich(g.measure)}</td><td class="num now">${rich(g.now)}</td><td class="num">${rich(g.week || 'n/a')}</td><td class="num">${rich(g.year || 'n/a')}</td></tr>`).join('')}
      </tbody></table></div></section>` : '';
    const itemsHTML = items.map((it) => `<section class="news-sec news-item">
      <h3>${rich(it.headline)}</h3>
      ${arr(it.bullets).length ? `<ul>${arr(it.bullets).map((b) => `<li>${rich(b)}</li>`).join('')}</ul>` : ''}
      ${it.takeaway ? `<div class="news-means"><b>What it means for your rates:</b> ${rich(it.takeaway)}</div>` : ''}
    </section>`).join('');
    const headsHTML = heads.length ? `<section class="news-sec"><h3 class="news-h">More freight news this week</h3><ul class="news-heads">
      ${heads.map((h) => `<li>${link(h.url, esc(h.title))}<span class="src">${esc([h.source, h.date ? day(h.date, { month: 'short', day: 'numeric' }) : ''].filter(Boolean).join(' · '))}</span>${h.summary ? `<p>${rich(h.summary)}</p>` : ''}</li>`).join('')}
    </ul></section>` : '';
    const groups = [];
    sources.forEach((s) => { const k = s.item || 'Sources'; let g = groups.find((x) => x.k === k); if (!g) groups.push(g = { k, list: [] }); g.list.push(s); });
    const sourcesHTML = groups.length ? `<section class="news-sec news-sources"><h3 class="news-h">Sources</h3>
      ${groups.map((g) => `<div><b>${esc(g.k)}:</b> ${g.list.map((s) => link(s.url, esc([s.publisher, s.title].filter(Boolean).join(', ')) + (s.date ? ' (' + esc(day(s.date, SHORT)) + ')' : ''))).join('; ')}</div>`).join('')}
    </section>` : '';
    const week = `Week of ${esc(day(u.week_of))}`;
    return `<header class="news-head">
        ${opt.notice || ''}
        <div class="news-week">${opt.permalink && !draft ? `<a href="${esc(weekUrl(u.week_of))}">${week}</a>` : week}</div>
        <h2 class="news-title">${esc(u.title)}</h2>
        ${u.summary ? `<p class="news-summary">${rich(u.summary)}</p>` : ''}
        ${bar}
      </header>
      ${glanceHTML}${itemsHTML}${headsHTML}${sourcesHTML}
      <footer class="news-foot"><p>Compiled from public market data and trucking news. Figures are the latest available when published and are averages, not quotes or advice.</p>
        <a class="qf-btn qf-btn-primary" href="/">Price a lane</a></footer>`;
  }

  // Every week's update, newest first, each linking to its own page (the owner also sees drafts)
  const archiveHTML = (list, current) => arr(list).map((x) => `<a href="${esc(weekUrl(x.week_of))}" class="${current && x.id === current.id ? 'on' : ''}">
      <span><b>${esc(x.title)}</b>${x.status === 'draft' ? '<span class="tag">Draft</span>' : ''}${x.summary ? `<small>${esc(plain(x.summary))}</small>` : ''}</span>
      <span class="wk">Week of ${esc(day(x.week_of, SHORT))}</span></a>`).join('');

  // The weeks listed beside an update: the newest RECENT
  const recent = (list) => arr(list).slice(0, RECENT);

  // The archive page: every week, newest first, under a heading for each month
  function archiveByMonth(list, current) {
    let month = '';
    return arr(list).map((x) => {
      const m = day(x.week_of, { month: 'long', year: 'numeric' });
      const head = m !== month ? `<h3 class="news-arch-h">${esc(m)}</h3>` : '';
      month = m;
      return head + archiveHTML([x], current);
    }).join('');
  }

  // A week from a month or more before the latest one says so, and points to the latest
  function oldNotice(u, latest) {
    if (!u || !latest || u.status !== 'published' || u.week_of === latest.week_of) return '';
    const gap = (Date.parse(String(latest.week_of).slice(0, 10) + 'T00:00:00Z') - Date.parse(String(u.week_of).slice(0, 10) + 'T00:00:00Z')) / 864e5;
    if (!(gap >= 28)) return '';
    return `<p class="news-old">This update is from ${esc(day(u.week_of))}. Rates and diesel have moved since. <a href="/market-news">See the latest update →</a></p>`;
  }

  // The weeks before and after this one (published ones, newest first in `published`)
  function neighbors(published, u) {
    const list = arr(published);
    const i = u ? list.findIndex((x) => x.week_of === u.week_of) : -1;
    return { older: i >= 0 && i < list.length - 1 ? list[i + 1] : null, newer: i > 0 ? list[i - 1] : null };
  }
  const pagerHTML = (n) => (n && (n.older || n.newer)
    ? (n.older ? `<a class="news-older" href="${esc(weekUrl(n.older.week_of))}"><span>← Previous week</span><b>${esc(n.older.title)}</b></a>` : '<span></span>')
      + (n.newer ? `<a class="news-newer" href="${esc(weekUrl(n.newer.week_of))}"><span>Next week →</span><b>${esc(n.newer.title)}</b></a>` : '')
    : '');

  const api = { RECENT, ARCHIVE_URL, esc, rich, safeUrl, link, day, arr, isWeek, weekUrl, plain, clip, heading, postHTML, archiveHTML,
    recent, archiveByMonth, oldNotice, neighbors, pagerHTML };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QFCNews = api;
})(typeof window !== 'undefined' ? window : this);
