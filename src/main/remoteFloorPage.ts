/**
 * The control page RemoteFloor serves at `/` — one static HTML document with
 * inline CSS and JS and no CDN, so it works with nothing but this laptop on
 * the tailnet. A TS string rather than an .html file so the main bundle carries
 * it with no copy step.
 *
 * Phone-first, light and dark via prefers-color-scheme. Four tabs: Floor,
 * Needs you, Mail, Actions. State arrives from `/api/state` and then live over
 * `/events` (SSE `change`). Every agent-written string is set with textContent,
 * never innerHTML, and a Remote Control link is used only when it is https.
 * Text boxes are plain <textarea>s, so the phone keyboard's mic dictates into
 * them; a re-render waits while one has focus so a live update never eats a
 * half-typed answer. Actions ask "Are you sure?" in the page, not confirm().
 *
 * No backticks or "${" below: this whole file is one template literal.
 */
export const REMOTE_FLOOR_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Munder Difflin floor</title>
<style>
:root {
  color-scheme: light;
  --bg: #f7f7f8; --surface: #ffffff; --raised: #f0f0f2; --text: #16161a; --muted: #6a6a74; --line: #e4e4e9;
  --accent: #4f46e5; --accent-text: #ffffff; --accent-soft: rgba(79,70,229,.10);
  --danger: #d6362b; --ok: #1f9d55; --warn: #c98512; --info: #3b82f6; --off: #9a9aa4;
  --ring: rgba(79,70,229,.45); --shadow: 0 1px 2px rgba(16,16,24,.06);
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #0b0b0e; --surface: #141418; --raised: #1c1c22; --text: #ededf0; --muted: #8e8e99; --line: #26262d;
    --accent: #8b8cf8; --accent-text: #0b0b14; --accent-soft: rgba(139,140,248,.14);
    --danger: #f2655a; --ok: #3ecf80; --warn: #f0b545; --info: #6aa5ff; --off: #5d5d68;
    --ring: rgba(139,140,248,.55); --shadow: none;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  -webkit-font-smoothing: antialiased; overflow-x: hidden;
  padding-bottom: calc(72px + env(safe-area-inset-bottom)); }
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
header { position: sticky; top: 0; z-index: 2; background: var(--bg); border-bottom: 1px solid var(--line);
  padding: 16px 16px 12px; padding-top: calc(16px + env(safe-area-inset-top)); }
.wrap { max-width: 720px; margin: 0 auto; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
h1 { font-size: 17px; line-height: 24px; margin: 0; font-weight: 650; letter-spacing: -.01em; min-width: 0; }
#conn { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); flex: none; }
#conn::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--warn); }
#conn.live::before { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 25%, transparent); }
#conn.off::before { background: var(--danger); }
#devices { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
#devices:empty { display: none; }
.chip { display: inline-flex; align-items: center; gap: 8px; padding: 0 8px; height: 24px; border-radius: 12px;
  background: var(--raised); border: 1px solid var(--line); font-size: 12px; color: var(--muted); max-width: 100%; }
main { padding: 16px; max-width: 720px; margin: 0 auto; }
nav { position: fixed; bottom: 0; left: 0; right: 0; z-index: 2; display: flex; background: var(--surface);
  border-top: 1px solid var(--line); padding-bottom: env(safe-area-inset-bottom); }
nav button { flex: 1; min-width: 0; border: 0; background: none; color: var(--muted); font: inherit; font-size: 11px;
  font-weight: 500; padding: 8px 4px; min-height: 56px; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 2px; cursor: pointer; }
nav svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
nav button[aria-selected="true"] { color: var(--accent); font-weight: 650; }
.seg { display: contents; }
nav .lbl { white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; }
.badge { display: inline-block; min-width: 18px; padding: 0 5px; border-radius: 9px; background: var(--danger);
  color: #fff; font-size: 11px; line-height: 18px; font-weight: 650; text-align: center; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 8px;
  box-shadow: var(--shadow); }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.head > div:first-child { min-width: 0; }
.name { font-weight: 600; font-size: 15px; line-height: 22px; overflow-wrap: anywhere; }
.meta { color: var(--muted); font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: var(--off); flex: none; }
.dot.s-working, .dot.d-online { background: var(--ok); }
.dot.s-needs-you { background: var(--danger); }
.dot.s-paused, .dot.d-connecting { background: var(--warn); }
.dot.s-idle { background: var(--info); }
.pill { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px; border-radius: 12px; flex: none;
  font-size: 12px; font-weight: 600; color: var(--off); background: color-mix(in srgb, var(--off) 15%, transparent); }
.pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.pill.s-working { color: var(--ok); background: color-mix(in srgb, var(--ok) 15%, transparent); }
.pill.s-idle { color: var(--info); background: color-mix(in srgb, var(--info) 15%, transparent); }
.pill.s-needs-you { color: var(--danger); background: color-mix(in srgb, var(--danger) 15%, transparent); }
.pill.s-paused { color: var(--warn); background: color-mix(in srgb, var(--warn) 18%, transparent); }
.tag { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 6px; background: var(--raised);
  border: 1px solid var(--line); font-size: 12px; color: var(--muted); }
.stats { display: flex; align-items: center; gap: 16px; margin-top: 16px; font-size: 12px; color: var(--muted); }
.ctx { flex: 1; min-width: 0; }
.bar { height: 4px; border-radius: 2px; background: var(--raised); overflow: hidden; margin-top: 4px; }
.bar i { display: block; height: 100%; border-radius: 2px; background: var(--accent); transition: width .3s ease; }
.bar i.hot { background: var(--warn); }
.bar i.full { background: var(--danger); }
.cost { text-align: right; flex: none; }
.stats b { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
.q { white-space: pre-wrap; margin: 8px 0 16px; overflow-wrap: anywhere; }
textarea, select { width: 100%; font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line);
  border-radius: 8px; padding: 8px 16px; min-height: 44px; }
textarea { min-height: 96px; resize: vertical; padding: 12px 16px; }
textarea::placeholder { color: var(--muted); }
button.act, a.link { font: inherit; font-size: 14px; font-weight: 600; border-radius: 8px; border: 1px solid var(--line);
  background: var(--surface); color: var(--text); padding: 0 16px; min-height: 44px; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; text-decoration: none; }
button.act:hover, a.link:hover { background: var(--raised); }
button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
button.primary:hover { background: var(--accent); filter: brightness(1.08); }
button.danger { background: var(--danger); color: #fff; border-color: var(--danger); }
button.danger:hover { background: var(--danger); filter: brightness(1.08); }
button:disabled { opacity: .5; cursor: default; }
a { color: var(--accent); }
a.link { color: var(--accent); margin-top: 16px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
.empty { color: var(--muted); text-align: center; padding: 48px 16px; }
.note { font-size: 13px; margin-top: 8px; color: var(--ok); }
.err { color: var(--danger); }
h2 { font-size: 12px; color: var(--muted); margin: 24px 0 8px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
h2:first-child { margin-top: 0; }
.mail-body { white-space: pre-wrap; font-size: 14px; margin-top: 8px; max-height: 12em; overflow: auto; overflow-wrap: anywhere; }
.gap { height: 8px; }
@media (min-width: 720px) {
  body { padding-bottom: 32px; }
  header { padding-bottom: 16px; }
  nav { position: static; border: 0; background: none; padding: 16px 0 0; max-width: 720px; margin: 0 auto; display: block; }
  nav .seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: 10px; background: var(--raised); border: 1px solid var(--line); }
  nav button { flex: none; flex-direction: row; gap: 8px; min-height: 44px; padding: 0 16px; border-radius: 8px; font-size: 14px; }
  nav button[aria-selected="true"] { background: var(--surface); color: var(--text); box-shadow: var(--shadow); }
  nav svg { display: none; }
  main { padding-top: 24px; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; scroll-behavior: auto !important; } }
</style>
</head>
<body>
<header>
  <div class="wrap">
    <div class="top"><h1>Munder Difflin floor</h1><div id="conn">Connecting…</div></div>
    <div id="devices"></div>
  </div>
  <nav role="tablist" aria-label="Sections"><div class="seg">
    <button role="tab" data-tab="floor"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg><span class="lbl">Floor</span></button>
    <button role="tab" data-tab="needs"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg><span class="lbl">Needs you<span id="needs-count"></span></span></button>
    <button role="tab" data-tab="mail"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg><span class="lbl">Mail</span></button>
    <button role="tab" data-tab="actions"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg><span class="lbl">Actions</span></button>
  </div></nav>
</header>
<main id="view"></main>
<script>
(function () {
  'use strict';
  var state = { agents: [], questions: [], mail: [], devices: [] };
  var tab = 'floor';
  try { tab = localStorage.getItem('floor-tab') || 'floor'; } catch (e) {}
  var drafts = {};
  var notes = {};
  var confirming = null;
  var pending = false;
  var busy = false;
  var view = document.getElementById('view');

  var STATUS = { working: 'Working', idle: 'Idle', 'needs-you': 'Needs you', paused: 'Paused', offline: 'Offline' };

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function safeUrl(u) { return typeof u === 'string' && /^https:\/\//i.test(u) ? u : null; }
  function agentName(id) {
    for (var i = 0; i < state.agents.length; i++) if (state.agents[i].id === id) return state.agents[i].name;
    return id;
  }
  function when(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function openLink(a) {
    var u = safeUrl(a.remoteControlUrl);
    return u ? el('a', { class: 'link', href: u, target: '_blank', rel: 'noopener', text: 'Open in Claude app' }) : null;
  }
  function note(key) {
    var n = notes[key];
    return n ? el('div', { class: 'note' + (n.err ? ' err' : ''), text: n.text }) : null;
  }

  function post(path, body, key, done) {
    busy = true; render();
    fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (r) {
        notes[key] = r.ok ? { text: 'Done.' } : { text: 'That did not work' + (r.error ? ': ' + r.error : '.'), err: true };
        if (r.ok && done) done();
      })
      .catch(function () { notes[key] = { text: 'Could not reach the laptop. Try again.', err: true }; })
      .then(function () { busy = false; render(); });
  }

  function floor() {
    if (!state.agents.length) return [el('div', { class: 'empty', text: 'No agents on the floor.' })];
    return state.agents.map(function (a) {
      var pct = a.contextPct != null ? Math.max(0, Math.min(100, Math.round(a.contextPct))) : null;
      var stats = [];
      if (pct != null) stats.push(el('div', { class: 'ctx' }, [
        el('div', { text: 'Context ' + pct + '%' }),
        el('div', { class: 'bar' }, [el('i', { class: pct >= 90 ? 'full' : pct >= 70 ? 'hot' : '', style: 'width:' + pct + '%' })])
      ]));
      if (a.costTodayUsd != null) stats.push(el('div', { class: 'cost' }, [
        el('div', { text: 'Today' }), el('b', { text: '$' + a.costTodayUsd.toFixed(2) })
      ]));
      return el('div', { class: 'card' }, [
        el('div', { class: 'head' }, [
          el('div', {}, [el('div', { class: 'name', text: a.name }), el('div', { class: 'meta', text: a.role || '' })]),
          el('span', { class: 'pill s-' + a.status, text: STATUS[a.status] || a.status })
        ]),
        a.device && a.device !== 'local' || a.deliveryPaused ? el('div', { class: 'row', style: 'margin-top:8px' }, [
          a.device && a.device !== 'local' ? el('span', { class: 'tag', text: a.device }) : null,
          a.deliveryPaused ? el('span', { class: 'tag', text: 'delivery paused' }) : null
        ]) : null,
        stats.length ? el('div', { class: 'stats' }, stats) : null,
        openLink(a)
      ]);
    });
  }

  function needs() {
    var out = [];
    if (state.questions.length) out.push(el('h2', { text: 'Questions from god' }));
    state.questions.forEach(function (q) {
      var key = q.taskId + ':' + q.qIndex;
      var box = el('textarea', { placeholder: 'Type or speak your answer', enterkeyhint: 'send',
        'aria-label': 'Answer', oninput: function () { drafts[key] = box.value; } });
      box.value = drafts[key] || '';
      out.push(el('div', { class: 'card' }, [
        el('div', { class: 'head' }, [el('div', { class: 'name', text: q.taskTitle }),
          q.askedAt ? el('div', { class: 'meta', text: when(q.askedAt) }) : null]),
        el('div', { class: 'q', text: q.q }),
        box,
        el('div', { class: 'actions' }, [
          el('button', { class: 'act primary', text: 'Send answer', onclick: function () {
            var text = (drafts[key] || '').trim();
            if (!text) return;
            post('/api/answer', { taskId: q.taskId, qIndex: q.qIndex, text: text }, key, function () { drafts[key] = ''; });
          } })
        ]),
        note(key)
      ]));
    });
    var waiting = state.agents.filter(function (a) { return a.status === 'needs-you'; });
    if (waiting.length) out.push(el('h2', { text: 'Waiting for your OK' }));
    waiting.forEach(function (a) {
      out.push(el('div', { class: 'card' }, [
        el('div', { class: 'head' }, [el('div', { class: 'name', text: a.name }), el('span', { class: 'pill s-needs-you', text: 'Waiting' })]),
        el('div', { class: 'meta', text: 'Waiting on a permission prompt.' }),
        openLink(a) || el('div', { class: 'meta', text: 'Open it on the laptop: no Claude app link for this agent.' })
      ]));
    });
    if (!out.length) out.push(el('div', { class: 'empty', text: 'Nothing needs you right now.' }));
    return out;
  }

  function mail() {
    var out = [];
    var to = el('select', { 'aria-label': 'Send to' }, state.agents.map(function (a) {
      return el('option', { value: a.id, text: a.name });
    }));
    if (drafts['mail-to']) to.value = drafts['mail-to'];
    to.addEventListener('change', function () { drafts['mail-to'] = to.value; });
    var box = el('textarea', { placeholder: 'Type or speak a message', enterkeyhint: 'send', 'aria-label': 'Message',
      oninput: function () { drafts.mail = box.value; } });
    box.value = drafts.mail || '';
    out.push(el('div', { class: 'card' }, [
      el('div', { class: 'name', text: 'Send a message' }), to,
      el('div', { class: 'gap' }), box,
      el('div', { class: 'actions' }, [
        el('button', { class: 'act primary', text: 'Send', onclick: function () {
          var text = (drafts.mail || '').trim();
          if (!text || !to.value) return;
          post('/api/mail', { agentId: to.value, text: text }, 'mail', function () { drafts.mail = ''; });
        } })
      ]),
      note('mail')
    ]));
    out.push(el('h2', { text: 'Latest mail' }));
    if (!state.mail.length) out.push(el('div', { class: 'empty', text: 'No mail yet.' }));
    state.mail.forEach(function (m) {
      out.push(el('div', { class: 'card' }, [
        el('div', { class: 'head' }, [el('div', { class: 'meta', text: agentName(m.from) + ' → ' + agentName(m.to) }),
          el('div', { class: 'meta', text: when(m.createdAt) })]),
        el('div', { class: 'name', text: m.subject }),
        el('div', { class: 'mail-body', text: m.body })
      ]));
    });
    return out;
  }

  function actions() {
    if (!state.agents.length) return [el('div', { class: 'empty', text: 'No agents on the floor.' })];
    return state.agents.map(function (a) {
      var choices = [
        { kind: 'stop', label: 'Stop', ask: 'Stop ' + a.name + '? It finishes the current step and stops.' },
        { kind: 'restart', label: 'Restart', ask: 'Restart ' + a.name + '? It picks up its conversation where it can.' },
        { kind: 'delivery', label: a.deliveryPaused ? 'Resume delivery' : 'Pause delivery',
          ask: a.deliveryPaused ? 'Let queued messages reach ' + a.name + ' again?' : 'Hold new messages for ' + a.name + ' until you resume?' }
      ];
      var kids = [el('div', { class: 'head' }, [el('div', { class: 'name', text: a.name }),
        el('span', { class: 'pill s-' + a.status, text: STATUS[a.status] || a.status })])];
      var c = confirming && confirming.id === a.id ? choices.filter(function (x) { return x.kind === confirming.kind; })[0] : null;
      if (c) {
        kids.push(el('div', { class: 'q', text: c.ask }));
        kids.push(el('div', { class: 'actions' }, [
          el('button', { class: 'act ' + (c.kind === 'delivery' ? 'primary' : 'danger'), text: 'Yes, ' + c.label.toLowerCase(),
            onclick: function () {
              confirming = null;
              post('/api/agents/' + encodeURIComponent(a.id) + '/' + c.kind,
                c.kind === 'delivery' ? { paused: !a.deliveryPaused } : {}, 'act:' + a.id);
            } }),
          el('button', { class: 'act', text: 'Cancel', onclick: function () { confirming = null; render(); } })
        ]));
      } else {
        kids.push(el('div', { class: 'actions' }, choices.map(function (x) {
          return el('button', { class: 'act', text: x.label, onclick: function () {
            confirming = { id: a.id, kind: x.kind }; delete notes['act:' + a.id]; render();
          } });
        })));
      }
      kids.push(note('act:' + a.id));
      return el('div', { class: 'card' }, kids);
    });
  }

  function render() {
    var f = document.activeElement;
    if (f && (f.tagName === 'TEXTAREA' || f.tagName === 'SELECT') && view.contains(f)) { pending = true; return; }
    pending = false;
    var devs = document.getElementById('devices');
    devs.textContent = '';
    state.devices.forEach(function (d) {
      devs.appendChild(el('span', { class: 'chip' }, [el('span', { class: 'dot d-' + d.state }), d.name + ' · ' + d.state]));
    });
    var n = state.questions.length + state.agents.filter(function (a) { return a.status === 'needs-you'; }).length;
    var badge = document.getElementById('needs-count');
    badge.textContent = '';
    if (n) badge.appendChild(el('span', { class: 'badge', text: String(n) }));
    document.querySelectorAll('nav button').forEach(function (b) {
      b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === tab));
    });
    var kids = ({ floor: floor, needs: needs, mail: mail, actions: actions }[tab] || floor)();
    view.textContent = '';
    kids.forEach(function (k) { if (k) view.appendChild(k); });
    view.querySelectorAll('button').forEach(function (b) { if (busy) b.disabled = true; });
  }

  view.addEventListener('focusout', function () { setTimeout(function () { if (pending) render(); }, 0); });
  document.querySelectorAll('nav button').forEach(function (b) {
    b.addEventListener('click', function () {
      tab = b.getAttribute('data-tab'); confirming = null;
      try { localStorage.setItem('floor-tab', tab); } catch (e) {}
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      pending = false; render();
    });
  });

  function setState(s) { if (s && s.agents) { state = s; render(); } }
  var conn = document.getElementById('conn');
  fetch('/api/state').then(function (r) { return r.ok ? r.json() : null; }).then(setState).catch(function () {});
  var es = new EventSource('/events');
  es.addEventListener('change', function (e) { try { setState(JSON.parse(e.data)); } catch (x) {} });
  es.onopen = function () { conn.textContent = 'Live'; conn.className = 'live'; };
  es.onerror = function () { conn.textContent = 'Reconnecting…'; conn.className = 'off'; };
  render();
})();
</script>
</body>
</html>
`;
