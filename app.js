(() => {
  'use strict';

  /* ---------- config ---------- */
  const PEOPLE = [
    { id: 'sanchay', name: 'Sanchay', color: '#a78bfa' },
    { id: 'hars',    name: 'Hars',    color: '#a3e635' },
    { id: 'assank',  name: 'Assank',  color: '#fb923c' },
    { id: 'abinov',  name: 'Abinov',  color: '#22d3ee' },
  ];
  const P = Object.fromEntries(PEOPLE.map(p => [p.id, p]));
  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  const POLL_MS = 4000;
  const RING_C = 402.12;

  const DB_URL = String((window.CODEX_QUEUE_CONFIG || {}).databaseURL || '').trim().replace(/\/+$/, '');
  const SHARED = DB_URL !== '';

  const $ = sel => document.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');

  /* ---------- storage ---------- */
  function remoteStore() {
    const call = async (path, method = 'GET', body) => {
      const res = await fetch(`${DB_URL}/queue/${path}.json`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    };
    return {
      load: async () => (await call('')) || {},
      add: async (kind, obj) => (await call(kind, 'POST', obj)).name,
      patch: (kind, id, obj) => call(`${kind}/${id}`, 'PATCH', obj),
      remove: (kind, id) => call(`${kind}/${id}`, 'DELETE'),
    };
  }

  function localStore() {
    const KEY = 'codexq:v1';
    const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
    const write = d => { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* ignore */ } };
    return {
      load: async () => read(),
      add: async (kind, obj) => {
        const d = read(); const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        (d[kind] ||= {})[id] = obj; write(d); return id;
      },
      patch: async (kind, id, obj) => {
        const d = read(); if (d[kind]?.[id]) { Object.assign(d[kind][id], obj); write(d); }
      },
      remove: async (kind, id) => { const d = read(); if (d[kind]) { delete d[kind][id]; write(d); } },
    };
  }

  const store = SHARED ? remoteStore() : localStore();

  /* ---------- state ---------- */
  let bookings = [];
  let burns = [];
  let usage = [];
  let signature = '';
  let me = null;
  try { me = localStorage.getItem('codexq:me'); } catch { /* ignore */ }
  if (!P[me]) me = null;
  let dayStart0 = startOfDay(Date.now());
  let syncState = SHARED ? 'connecting' : 'local';

  const form = { mode: 'now', hours: 2 };

  /* ---------- time helpers ---------- */
  function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function shiftDay(ts, n) { const d = new Date(ts); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return d.getTime(); }
  const t12 = ts => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const hms = ms => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}`;
  };
  const dur = ms => {
    const m = Math.max(0, Math.round(ms / MIN));
    if (m < 60) return `${m}m`;
    return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
  };
  function dayWord(ts) {
    const diff = Math.round((startOfDay(ts) - startOfDay(Date.now())) / DAY);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function range(s, e) {
    const sameDay = startOfDay(s) === startOfDay(e);
    return `${dayWord(s)} ${t12(s)} → ${t12(e)}${sameDay ? '' : ' (' + dayWord(e) + ')'}`;
  }
  const toInput = ts => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const ceil5 = ts => Math.ceil(ts / (5 * MIN)) * 5 * MIN;

  /* ---------- derived ---------- */
  const liveBookings = () => bookings.filter(b => b.end > Date.now()).sort((a, b) => a.start - b.start);
  const currentBooking = now => bookings.find(b => b.start <= now && now < b.end);
  const nextBooking = now => liveBookings().find(b => b.start > now);
  const activeLimit = now => burns.filter(b => b.resetsAt > now).sort((a, b) => b.resetsAt - a.resetsAt)[0];

  function nextFree(durMs, from = Date.now()) {
    const lim = activeLimit(from);
    let t = ceil5(Math.max(from, lim ? lim.resetsAt : 0));
    for (const b of liveBookings()) {
      if (b.end <= t) continue;
      if (b.start >= t + durMs) break;
      t = ceil5(b.end);
    }
    return t;
  }

  /* ---------- data sync ---------- */
  function normalise(raw) {
    const list = obj => Object.entries(obj || {}).filter(([, v]) => v && typeof v === 'object').map(([id, v]) => ({ id, ...v }));
    const cutoff = Date.now() - 8 * DAY;
    bookings = list(raw.bookings).filter(b => P[b.who] && b.end > cutoff);
    burns = list(raw.burns).filter(b => P[b.who] && b.resetsAt > cutoff);
    usage = list(raw.usage).filter(u => P[u.who] && u.resetsAt > cutoff);
  }

  // The 5h window currently ticking: sum of logged usage that hasn't reset yet.
  function currentWindow(now) {
    const lim = activeLimit(now);
    const open = usage.filter(u => u.resetsAt > now).sort((a, b) => b.at - a.at);
    if (!open.length && !lim) return null;
    const resetsAt = lim ? lim.resetsAt : open[0].resetsAt;
    const used = lim ? 100 : Math.min(100, open.reduce((s, u) => s + u.pct, 0));
    return { resetsAt, used, left: 100 - used };
  }

  async function refresh(force = false) {
    try {
      const raw = await store.load();
      if (SHARED) setSync('live');
      const sig = JSON.stringify(raw);
      if (sig !== signature || force) {
        signature = sig;
        normalise(raw);
        renderAll();
      }
    } catch (err) {
      console.warn('sync failed', err);
      setSync('err');
    }
  }

  function setSync(s) {
    if (s === syncState) return;
    syncState = s;
    renderSync();
  }

  /* ---------- rendering: header ---------- */
  const avatar = (p, cls = '') => `<span class="av ${cls}" style="--c:${p.color}">${esc(p.name[0])}</span>`;

  function renderMe() {
    const btn = $('#meBtn');
    btn.innerHTML = me ? `${avatar(P[me])}<span>${esc(P[me].name)}</span>` : '<span style="padding-left:10px">Who are you?</span>';
    $('#whoLabel').textContent = me ? `as ${P[me].name}` : 'pick who you are';
  }

  function renderSync() {
    const pill = $('#syncPill');
    const map = {
      live: ['live', 'live · shared', 'Connected. Everyone sees the same bookings.'],
      connecting: ['', 'connecting', ''],
      err: ['err', 'offline', 'Could not reach the database. Retrying...'],
      local: ['warn', 'local only', 'No database URL in config.js yet, so bookings are only saved in this browser. See README.md.'],
    };
    const [cls, label, tip] = map[syncState];
    pill.className = 'pill ' + cls;
    pill.querySelector('span').textContent = label;
    pill.title = tip;
  }

  /* ---------- rendering: hero ---------- */
  let statusKey = '';
  let statusCtx = null;

  function renderStatus() {
    const now = Date.now();
    const lim = activeLimit(now);
    const cur = currentBooking(now);
    const nxt = nextBooking(now);
    const hero = $('#status');

    let key, ctx;
    if (lim) {
      key = `L${lim.id}:${me}`;
      ctx = { mode: 'limit', from: lim.at, to: lim.resetsAt, lim };
    } else if (cur) {
      key = `B${cur.id}:${cur.end}:${me}:${nxt ? nxt.id : ''}`;
      ctx = { mode: 'busy', from: cur.start, to: cur.end, cur, nxt };
    } else {
      key = `F${nxt ? nxt.id + ':' + nxt.start : ''}:${me}`;
      ctx = { mode: 'free', from: now, to: nxt ? nxt.start : null, nxt };
    }
    statusCtx = ctx;
    const win = currentWindow(now);
    key += win ? `|${win.resetsAt}:${win.used}` : '|';

    if (key !== statusKey) {
      statusKey = key;
      hero.className = `hero ${ctx.mode === 'busy' ? 'busy' : ctx.mode}`;
      hero.style.setProperty('--state', ctx.mode === 'busy' ? P[ctx.cur.who].color : '');
      if (ctx.mode !== 'busy') hero.style.removeProperty('--state');

      let center, eyebrow, title, sub, actions;
      if (ctx.mode === 'limit') {
        const p = P[lim.who];
        center = avatar(p, 'xl');
        eyebrow = 'limit burned';
        title = `${esc(p.name)} torched the limit`;
        sub = `Back at <b>${t12(lim.resetsAt)}</b> (${dayWord(lim.resetsAt).toLowerCase()}). Nobody can book before then.`;
        actions = `<button class="btn primary" data-act="queue">Queue for after reset</button>
                   <button class="btn ghost" data-act="clearlimit">False alarm, clear it</button>`;
      } else if (ctx.mode === 'busy') {
        const p = P[cur.who];
        const mine = cur.who === me;
        center = avatar(p, 'xl');
        eyebrow = 'in use';
        title = mine ? "You're on Codex" : `${esc(p.name)} is on Codex`;
        sub = (cur.note ? `“${esc(cur.note)}” · ` : '') + `until <b>${t12(cur.end)}</b>` +
              (nxt ? ` · next up <b>${esc(P[nxt.who].name)}</b> at ${t12(nxt.start)}` : ' · nobody queued after');
        actions = (mine ? `<button class="btn primary" data-act="end">End my session</button>` : `<button class="btn primary" data-act="queue">Queue after ${esc(p.name)}</button>`) +
                  `<button class="btn" data-act="usage">📊 Log usage</button><button class="btn danger" data-act="burn">🔥 Limit hit</button>`;
      } else {
        center = '<span class="free-ico">🟢</span>';
        eyebrow = 'available';
        title = 'Codex is free';
        sub = nxt ? `<b>${esc(P[nxt.who].name)}</b> is booked at ${t12(nxt.start)}, so you have <b id="freeFor">${dur(nxt.start - now)}</b>.` : 'Nobody is queued. Go wild.';
        actions = `<button class="btn primary" data-act="hop">Hop on now</button>
                   <button class="btn" data-act="usage">📊 Log usage</button>
                   <button class="btn danger" data-act="burn">🔥 Limit hit</button>`;
      }

      const meter = win
        ? `<div class="meter ${win.used >= 85 ? 'hot' : win.used >= 60 ? 'warm' : ''}">
             <div class="meter-top"><span><b>${win.left}%</b> of the 5h window left</span><span>resets ${t12(win.resetsAt)} (${dur(win.resetsAt - now)})</span></div>
             <div class="meter-bar"><i style="width:${win.used}%"></i></div>
           </div>`
        : `<div class="meter none"><div class="meter-top"><span>No usage logged this window. Hit <b>Log usage</b> after a session so the rest of us know how much is left.</span></div></div>`;

      hero.innerHTML = `
        <div class="hero-ring">
          <svg viewBox="0 0 150 150"><circle class="trk" cx="75" cy="75" r="64"/><circle class="prg" id="ringFg" cx="75" cy="75" r="64"/></svg>
          <div class="center">${center}</div>
        </div>
        <div class="hero-body">
          <div class="eyebrow"><span class="dot"></span>${eyebrow}</div>
          <h1>${title}</h1>
          <div class="clock" id="clock"></div>
          <p class="sub">${sub}</p>
          ${meter}
          <div class="actions">${actions}</div>
        </div>`;
    }

    // per-second updates
    const clock = $('#clock'), ring = $('#ringFg');
    if (!clock || !ring) return;
    let text, frac;
    if (ctx.mode === 'free') {
      text = ctx.to ? hms(ctx.to - now) : 'OPEN';
      frac = 1;
      const ff = $('#freeFor'); if (ff && ctx.to) ff.textContent = dur(ctx.to - now);
    } else {
      text = hms(ctx.to - now);
      frac = Math.min(1, Math.max(0, (ctx.to - now) / (ctx.to - ctx.from)));
    }
    if (clock.textContent !== text) clock.textContent = text;
    ring.style.strokeDashoffset = String(RING_C * (1 - frac));

    // tab title doubles as a status light
    const emoji = ctx.mode === 'free' ? '🟢' : ctx.mode === 'limit' ? '🔥' : '🔴';
    const who = ctx.mode === 'busy' ? P[ctx.cur.who].name : ctx.mode === 'limit' ? 'limit' : 'free';
    document.title = ctx.mode === 'free' ? `${emoji} Codex free` : `${emoji} ${who} · ${hms(ctx.to - now)}`;
  }

  /* ---------- rendering: queue ---------- */
  function renderQueue() {
    const now = Date.now();
    const lim = activeLimit(now);
    const list = liveBookings();
    $('#queueCount').textContent = list.length ? `${list.length} booked` : '';
    $('#queue').innerHTML = list.length ? list.map(b => {
      const p = P[b.who];
      const live = b.start <= now;
      const blocked = !live && lim && b.start < lim.resetsAt;
      const mine = b.who === me;
      const rel = live ? `ends in ${dur(b.end - now)}` : `in ${dur(b.start - now)}`;
      return `<li class="${live ? 'live' : ''} ${blocked ? 'blocked' : ''}" style="--c:${p.color}">
        ${avatar(p)}
        <div class="info">
          <div class="nm">${esc(p.name)}${live ? '<span class="tag live">live</span>' : ''}${blocked ? '<span class="tag warn">limit on</span>' : ''}</div>
          <div class="when">${range(b.start, b.end)} · ${rel}</div>
          ${b.note ? `<div class="note">${esc(b.note)}</div>` : ''}
        </div>
        ${mine ? `<button class="x" data-act="${live ? 'end' : 'cancel'}" data-id="${esc(b.id)}" title="${live ? 'End now' : 'Cancel booking'}">${live ? '■' : '✕'}</button>` : ''}
      </li>`;
    }).join('') : `<li class="empty">Nobody queued. Be the first to book a slot.</li>`;
  }

  /* ---------- rendering: timeline ---------- */
  function renderTimeline() {
    const d0 = dayStart0, d1 = shiftDay(d0, 1), span = d1 - d0, now = Date.now();
    $('#dayLabel').textContent = dayWord(d0);
    const pct = ts => ((Math.min(Math.max(ts, d0), d1) - d0) / span) * 100;

    let scale = '';
    for (let h = 0; h < 24; h += 3) {
      const label = h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`;
      scale += `<span style="left:${(h / 24) * 100}%">${label}</span>`;
    }

    const rows = PEOPLE.map(p => {
      const blocks = bookings.filter(b => b.who === p.id && b.end > d0 && b.start < d1).map(b => {
        const l = pct(b.start), w = pct(b.end) - l;
        const cls = b.end <= now ? 'past' : b.start <= now ? 'live' : '';
        const label = w > 9 ? `${t12(b.start)}${b.note ? ' · ' + esc(b.note) : ''}` : '';
        return `<div class="blk ${cls}" style="--c:${p.color};left:${l}%;width:${w}%" title="${esc(p.name)}: ${esc(range(b.start, b.end))}${b.note ? ' | ' + esc(b.note) : ''}">${label}</div>`;
      }).join('');
      return `<div class="tl-row"><div class="tl-who">${avatar(p, 'sm')}${esc(p.name)}</div><div class="tl-track" data-who="${p.id}">${blocks}</div></div>`;
    }).join('');

    const locks = burns.filter(b => b.resetsAt > d0 && b.at < d1).map(b => {
      const l = pct(b.at), w = pct(b.resetsAt) - l;
      return `<div class="tl-lock" style="left:${l}%;width:${w}%">${w > 6 ? 'LIMIT' : ''}</div>`;
    }).join('');

    const nowLine = now >= d0 && now < d1 ? `<div class="tl-now" id="nowLine" style="left:${pct(now)}%"></div>` : '';

    $('#timeline').innerHTML = `
      <div class="tl-axis"><div></div><div class="scale">${scale}</div></div>
      <div class="tl-body">${rows}<div class="tl-over">${locks}${nowLine}</div></div>`;
  }

  function tickNowLine() {
    const el = $('#nowLine');
    if (!el) return;
    const d0 = dayStart0, d1 = shiftDay(d0, 1);
    el.style.left = `${((Date.now() - d0) / (d1 - d0)) * 100}%`;
  }

  /* ---------- rendering: stats ---------- */
  function renderStats() {
    const now = Date.now(), from = now - 7 * DAY;
    const rows = PEOPLE.map(p => {
      const used = bookings.filter(b => b.who === p.id).reduce((sum, b) => {
        const s = Math.max(b.start, from), e = Math.min(b.end, now);
        return sum + Math.max(0, e - s);
      }, 0);
      const ahead = bookings.filter(b => b.who === p.id && b.end > now).reduce((sum, b) => sum + (b.end - Math.max(b.start, now)), 0);
      const burnCount = burns.filter(b => b.who === p.id).length;
      const pct = usage.filter(u => u.who === p.id && u.at >= from).reduce((s, u) => s + u.pct, 0);
      return { p, used, ahead, burnCount, pct };
    });
    const max = Math.max(1, ...rows.map(r => r.used + r.ahead));
    const topUse = Math.max(...rows.map(r => r.used));
    const topBurn = Math.max(...rows.map(r => r.burnCount));
    $('#stats').innerHTML = rows.map(r => {
      const badges = [];
      if (topUse > 0 && r.used === topUse) badges.push('👑 gremlin of the week');
      if (topBurn > 0 && r.burnCount === topBurn) badges.push('🔥 limit destroyer');
      return `<div class="stat" style="--c:${r.p.color}">
        ${avatar(r.p)}
        <div class="nm">${esc(r.p.name)}<small>${badges.join(' · ') || '&nbsp;'}</small></div>
        <div class="bar"><i data-w="${Math.round(((r.used + r.ahead) / max) * 100)}"></i></div>
        <div class="num">${(r.used / HOUR).toFixed(1)}h<small>${r.pct ? r.pct + '% eaten · ' : ''}${r.burnCount} burn${r.burnCount === 1 ? '' : 's'}${r.ahead ? ' · +' + (r.ahead / HOUR).toFixed(1) + 'h booked' : ''}</small></div>
      </div>`;
    }).join('');
    requestAnimationFrame(() => document.querySelectorAll('.bar i').forEach(i => { i.style.width = i.dataset.w + '%'; }));
  }

  function renderAll() {
    statusKey = '';
    renderMe(); renderSync(); renderStatus(); renderQueue(); renderTimeline(); renderStats(); updateForm();
  }

  /* ---------- booking form ---------- */
  function formWindow() {
    const durMs = form.hours * HOUR;
    let start;
    if (form.mode === 'now') start = Math.floor(Date.now() / MIN) * MIN;
    else {
      start = new Date($('#startInput').value).getTime();
      if (!Number.isFinite(start)) return null;
    }
    return { start, end: start + durMs, durMs };
  }

  function checkWindow(w) {
    const now = Date.now();
    if (!w) return { ok: false, msg: 'Pick a start time.' };
    if (w.start < now - 5 * MIN) return { ok: false, msg: "That start time is in the past." };
    const lim = activeLimit(now);
    if (lim && w.start < lim.resetsAt) return { ok: false, msg: `Limit is burned until ${t12(lim.resetsAt)}.`, fix: true };
    const clash = liveBookings().find(b => b.start < w.end && b.end > w.start);
    if (clash) return { ok: false, msg: `Clashes with ${P[clash.who].name} (${t12(clash.start)} → ${t12(clash.end)}).`, fix: true };
    return { ok: true, msg: `All clear: ${range(w.start, w.end)}` };
  }

  let lastPreview = '';
  function updateForm() {
    document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === form.mode));
    document.querySelectorAll('#durChips button').forEach(b => b.classList.toggle('on', Number(b.dataset.h) === form.hours));
    $('#startInput').hidden = form.mode !== 'later';

    const w = formWindow();
    const res = checkWindow(w);
    const html = esc(res.msg) + (res.fix ? ' <button type="button" data-act="fixslot">Use next free slot</button>' : '');
    const key = (res.ok ? '1' : '0') + html;
    if (key !== lastPreview) {
      lastPreview = key;
      const box = $('#preview');
      box.className = 'preview' + (res.ok ? '' : ' bad');
      box.innerHTML = html;
    }
    $('#bookBtn').disabled = !res.ok;
  }

  function setLater(ts) {
    form.mode = 'later';
    $('#startInput').value = toInput(ts);
    updateForm();
  }

  function goToForm() {
    $('#bookCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function submitBooking() {
    if (!me) return pickWho(submitBooking);
    const w = formWindow();
    const res = checkWindow(w);
    if (!res.ok) return toast(res.msg, 'bad');
    const btn = $('#bookBtn');
    btn.disabled = true;
    try {
      const mine = { who: me, start: w.start, end: w.end, note: $('#note').value.trim().slice(0, 60), created: Date.now() };
      const id = await store.add('bookings', mine);
      // Two people can click at the same moment: earliest "created" wins, the other backs off.
      const raw = await store.load();
      normalise(raw);
      const loser = bookings.find(b => b.id !== id && b.start < w.end && b.end > w.start && b.who !== me &&
        ((b.created || 0) < mine.created || ((b.created || 0) === mine.created && b.id < id)));
      if (loser) {
        await store.remove('bookings', id);
        toast(`${P[loser.who].name} grabbed that slot a moment earlier. Try another.`, 'bad');
      } else {
        $('#note').value = '';
        toast(form.mode === 'now' ? "You're on. Make it count." : `Booked ${range(w.start, w.end)}`, 'good');
      }
    } catch (err) {
      console.warn(err);
      toast("Couldn't save. Check your connection.", 'bad');
    }
    await refresh(true);
  }

  /* ---------- actions ---------- */
  async function endSession(id) {
    const b = bookings.find(x => x.id === id) || currentBooking(Date.now());
    if (!b) return;
    await store.patch('bookings', b.id, { end: Math.max(b.start + MIN, Date.now()) });
    toast('Session ended. Codex is free.', 'good');
    await refresh(true);
    usageModal(); // ask how much of the window it ate
  }

  async function cancelBooking(id) {
    const b = bookings.find(x => x.id === id);
    if (!b || !confirm(`Cancel ${range(b.start, b.end)}?`)) return;
    await store.remove('bookings', id);
    toast('Booking cancelled.');
    await refresh(true);
  }

  async function clearLimit() {
    const lim = activeLimit(Date.now());
    if (!lim || !confirm('Clear the limit warning? Only do this if it was a false alarm.')) return;
    await Promise.all(burns.filter(b => b.resetsAt > Date.now()).map(b => store.remove('burns', b.id)));
    toast('Limit cleared.', 'good');
    await refresh(true);
  }

  /* ---------- modals ---------- */
  function openModal(html) {
    const m = $('#modal');
    m.innerHTML = `<div class="sheet" role="dialog">${html}</div>`;
    m.hidden = false;
    return m;
  }
  function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; }

  function pickWho(after) {
    const m = openModal(`
      <h3>Who's this?</h3>
      <p class="s">No passwords here. Just tap your name so bookings go under it.</p>
      <div class="who-grid">
        ${PEOPLE.map(p => `<button class="who-card ${p.id === me ? 'on' : ''}" data-who="${p.id}" style="--c:${p.color}">${avatar(p, 'lg')}${esc(p.name)}</button>`).join('')}
      </div>`);
    m.querySelectorAll('.who-card').forEach(btn => btn.addEventListener('click', () => {
      me = btn.dataset.who;
      try { localStorage.setItem('codexq:me', me); } catch { /* ignore */ }
      closeModal();
      renderAll();
      if (typeof after === 'function') after();
    }));
  }

  function usageModal() {
    if (!me) return pickWho(usageModal);
    const now = Date.now();
    const win = currentWindow(now);
    let who = me, pct = 10, mins = 300;
    const mOpts = [[120, '2h'], [180, '3h'], [240, '4h'], [300, '5h']];
    const m = openModal(`
      <h3>📊 Log usage</h3>
      <p class="s">Roughly how much of the 5h window did you just eat? Check the usage bar in Codex if you can.</p>
      <label class="lbl">Who used it?</label>
      <div class="mini" id="uWho">${PEOPLE.map(p => `<button type="button" class="who-pick" data-v="${p.id}" style="--c:${p.color}">${avatar(p, 'sm')}${esc(p.name)}</button>`).join('')}</div>
      <label class="lbl">Used <b id="uVal" style="color:var(--text)"></b> of the window</label>
      <input type="range" id="uRange" min="1" max="100" step="1" class="range">
      <div class="chips" id="uChips" style="margin-top:10px">${[5, 10, 20, 30, 50].map(v => `<button type="button" data-v="${v}">${v}%</button>`).join('')}</div>
      ${win ? `<p class="s" style="margin:16px 0 0">Window resets at <b style="color:var(--text)">${t12(win.resetsAt)}</b>. Already used: ${win.used}%.</p>` : `
      <label class="lbl">Window resets in <em>(window starts at your first message)</em></label>
      <div class="chips" id="uMins">${mOpts.map(([v, l]) => `<button type="button" data-v="${v}">${l}</button>`).join('')}</div>`}
      <p class="s" id="uWarn" style="margin:14px 0 0;color:#fda4af" hidden>That takes the window to 100%, so it will be marked as limit hit.</p>
      <div class="row"><button class="btn ghost" id="uCancel">Skip</button><button class="btn primary" id="uGo" style="--state:var(--accent)">Log it</button></div>`);
    const sync = () => {
      m.querySelectorAll('#uWho button').forEach(b => b.classList.toggle('on', b.dataset.v === who));
      m.querySelectorAll('#uChips button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === pct));
      m.querySelectorAll('#uMins button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === mins));
      $('#uRange').value = pct;
      $('#uVal').textContent = `${pct}%`;
      $('#uWarn').hidden = !((win ? win.used : 0) + pct >= 100);
    };
    m.querySelectorAll('#uWho button').forEach(b => b.addEventListener('click', () => { who = b.dataset.v; sync(); }));
    m.querySelectorAll('#uChips button').forEach(b => b.addEventListener('click', () => { pct = Number(b.dataset.v); sync(); }));
    m.querySelectorAll('#uMins button').forEach(b => b.addEventListener('click', () => { mins = Number(b.dataset.v); sync(); }));
    $('#uRange').addEventListener('input', e => { pct = Number(e.target.value); sync(); });
    $('#uCancel').addEventListener('click', closeModal);
    $('#uGo').addEventListener('click', async () => {
      const t = Date.now();
      const resetsAt = win ? win.resetsAt : t + mins * MIN;
      try {
        await store.add('usage', { who, at: t, pct: Math.min(pct, 100 - (win ? win.used : 0)), resetsAt });
        if ((win ? win.used : 0) + pct >= 100 && !activeLimit(t)) {
          await store.add('burns', { who, at: t, resetsAt });
          const cur = currentBooking(t);
          if (cur) await store.patch('bookings', cur.id, { end: Math.max(cur.start + MIN, t) });
          toast('Window is full. Marked as limit hit.');
        } else {
          toast(`Logged ${pct}% for ${P[who].name}.`, 'good');
        }
        closeModal();
      } catch (err) {
        console.warn(err);
        toast("Couldn't save. Check your connection.", 'bad');
      }
      await refresh(true);
    });
    sync();
  }

  function burnModal() {
    if (!me) return pickWho(burnModal);
    let who = me, mins = 300;
    const opts = [[30, '30m'], [60, '1h'], [120, '2h'], [180, '3h'], [240, '4h'], [300, '5h']];
    const m = openModal(`
      <h3>🔥 Limit hit</h3>
      <p class="s">Tell everyone Codex is dead for now so nobody wastes time trying.</p>
      <label class="lbl">Who burned it?</label>
      <div class="mini" id="bWho">${PEOPLE.map(p => `<button type="button" class="who-pick" data-v="${p.id}" style="--c:${p.color}">${avatar(p, 'sm')}${esc(p.name)}</button>`).join('')}</div>
      <label class="lbl">Resets in <em>(Codex tells you this when it cuts you off)</em></label>
      <div class="chips" id="bMins">${opts.map(([v, l]) => `<button type="button" data-v="${v}">${l}</button>`).join('')}</div>
      <div class="row"><button class="btn ghost" id="bCancel">Cancel</button><button class="btn danger" id="bGo">Mark limit hit</button></div>`);
    const sync = () => {
      m.querySelectorAll('#bWho button').forEach(b => b.classList.toggle('on', b.dataset.v === who));
      m.querySelectorAll('#bMins button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === mins));
    };
    m.querySelectorAll('#bWho button').forEach(b => b.addEventListener('click', () => { who = b.dataset.v; sync(); }));
    m.querySelectorAll('#bMins button').forEach(b => b.addEventListener('click', () => { mins = Number(b.dataset.v); sync(); }));
    $('#bCancel').addEventListener('click', closeModal);
    $('#bGo').addEventListener('click', async () => {
      const now = Date.now();
      try {
        const cur = currentBooking(now);
        if (cur) await store.patch('bookings', cur.id, { end: Math.max(cur.start + MIN, now) });
        await store.add('burns', { who, at: now, resetsAt: now + mins * MIN });
        closeModal();
        toast(`Marked. Codex is back around ${t12(now + mins * MIN)}.`);
      } catch (err) {
        console.warn(err);
        toast("Couldn't save. Check your connection.", 'bad');
      }
      await refresh(true);
    });
    sync();
  }

  /* ---------- toast ---------- */
  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  /* ---------- events ---------- */
  document.addEventListener('click', e => {
    const modal = $('#modal');
    if (e.target === modal) return closeModal();

    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    switch (act) {
      case 'switch': pickWho(); break;
      case 'sync': toast(el.title || 'Syncing...'); break;
      case 'hop': form.mode = 'now'; updateForm(); goToForm(); $('#note').focus({ preventScroll: true }); break;
      case 'queue': setLater(ceil5(nextFree(form.hours * HOUR))); goToForm(); break;
      case 'fixslot': setLater(ceil5(nextFree(form.hours * HOUR))); break;
      case 'end': if (!me) pickWho(); else endSession(el.dataset.id); break;
      case 'cancel': cancelBooking(el.dataset.id); break;
      case 'burn': burnModal(); break;
      case 'usage': usageModal(); break;
      case 'clearlimit': clearLimit(); break;
      case 'dayprev': dayStart0 = shiftDay(dayStart0, -1); renderTimeline(); break;
      case 'daynext': dayStart0 = shiftDay(dayStart0, 1); renderTimeline(); break;
      case 'daytoday': dayStart0 = startOfDay(Date.now()); renderTimeline(); break;
    }
  });

  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden && me) closeModal(); });

  $('#modeSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    form.mode = b.dataset.mode;
    if (form.mode === 'later' && !$('#startInput').value) $('#startInput').value = toInput(ceil5(nextFree(form.hours * HOUR)));
    updateForm();
  });
  $('#durChips').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    form.hours = Number(b.dataset.h); updateForm();
  });
  $('#startInput').addEventListener('input', updateForm);
  $('#bookBtn').addEventListener('click', submitBooking);
  $('#note').addEventListener('keydown', e => { if (e.key === 'Enter') submitBooking(); });

  // click an empty spot on your own row to schedule from there
  $('#timeline').addEventListener('click', e => {
    const track = e.target.closest('.tl-track');
    if (!track || e.target.closest('.blk')) return;
    if (!me) return pickWho();
    if (track.dataset.who !== me) return toast(`That's ${P[track.dataset.who].name}'s row. Tap yours.`);
    const r = track.getBoundingClientRect();
    const frac = (e.clientX - r.left) / r.width;
    const d1 = shiftDay(dayStart0, 1);
    let ts = Math.round((dayStart0 + frac * (d1 - dayStart0)) / (30 * MIN)) * 30 * MIN;
    ts = Math.max(ts, ceil5(Date.now()));
    setLater(ts);
    goToForm();
  });

  window.addEventListener('storage', e => { if (!SHARED && e.key === 'codexq:v1') refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  /* ---------- boot ---------- */
  let ticks = 0;
  function tick() {
    ticks++;
    renderStatus();
    tickNowLine();
    updateForm();
    if (ticks % 30 === 0) { renderQueue(); renderStats(); }
  }

  renderAll();
  refresh(true).then(() => { if (!me) pickWho(); });
  setInterval(refresh, POLL_MS);
  setInterval(tick, 1000);
})();
