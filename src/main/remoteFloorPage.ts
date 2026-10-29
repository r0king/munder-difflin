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
  --bg: #f6f6f4; --card: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --line: #e2e2dc;
  --accent: #2f6fdb; --accent-text: #ffffff; --danger: #c43c2f;
  --ok: #2e9b57; --warn: #d99a1e; --off: #9a9a94;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131312; --card: #1e1e1c; --text: #ecece8; --muted: #a2a29b; --line: #34342f;
    --accent: #6c9cf0; --accent-text: #0e1420; --danger: #ef6a5c;
    --ok: #4cc27a; --warn: #f0b545; --off: #6e6e68;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  padding-bottom: calc(64px + env(safe-area-inset-bottom)); }
header { position: sticky; top: 0; background: var(--bg); padding: 12px 16px 8px;
  border-bottom: 1px solid var(--line); z-index: 1; }
h1 { font-size: 18px; margin: 0; }
#conn { font-size: 13px; color: var(--muted); }
#devices { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 6px; font-size: 13px; color: var(--muted); }
main { padding: 12px 16px; max-width: 720px; margin: 0 auto; }
nav { position: fixed; bottom: 0; left: 0; right: 0; display: flex; background: var(--card);
  border-top: 1px solid var(--line); padding-bottom: env(safe-area-inset-bottom); }
nav button { flex: 1; border: 0; background: none; color: var(--muted); font: inherit; font-size: 14px;
  padding: 12px 4px; min-height: 52px; }
nav button[aria-selected="true"] { color: var(--accent); font-weight: 600; }
.badge { display: inline-block; min-width: 18px; padding: 0 5px; border-radius: 9px; background: var(--danger);
  color: #fff; font-size: 12px; line-height: 18px; margin-left: 4px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.name { font-weight: 600; }
.meta { color: var(--muted); font-size: 14px; }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; background: var(--off); flex: none; }
.s-working, .d-online { background: var(--ok); }
.s-needs-you { background: var(--danger); }
.s-paused, .d-connecting { background: var(--warn); }
.s-idle { background: var(--accent); }
.q { white-space: pre-wrap; margin: 6px 0 10px; }
textarea, select { width: 100%; font: inherit; color: var(--text); background: var(--bg);
  border: 1px solid var(--line); border-radius: 10px; padding: 10px; }
textarea { min-height: 88px; resize: vertical; }
button.act { font: inherit; border-radius: 10px; border: 1px solid var(--line); background: var(--card);
  color: var(--text); padding: 9px 14px; min-height: 44px; }
button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
button.danger { background: var(--danger); color: #fff; border-color: var(--danger); }
button:disabled { opacity: .5; }
a { color: var(--accent); }
.empty { color: var(--muted); text-align: center; padding: 24px 0; }
.note { font-size: 14px; margin-top: 6px; }
.err { color: var(--danger); }
h2 { font-size: 15px; color: var(--muted); margin: 16px 0 8px; font-weight: 600; }
.mail-body { white-space: pre-wrap; font-size: 14px; margin-top: 4px; max-height: 12em; overflow: auto; }
</style>
</head>
<body>
<header>
  <h1>Munder Difflin floor</h1>
  <div id="conn">Connecting…</div>
  <div id="devices"></div>
</header>
<main id="view"></main>
<nav role="tablist">
  <button role="tab" data-tab="floor">Floor</button>
  <button role="tab" data-tab="needs">Needs you<span id="needs-count"></span></button>
  <button role="tab" data-tab="mail">Mail</button>
  <button role="tab" data-tab="actions">Actions</button>
</nav>
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
    return u ? el('a', { href: u, target: '_blank', rel: 'noopener', text: 'Open in Claude app' }) : null;
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
      var bits = [a.role, a.device === 'local' ? 'this laptop' : a.device];
      if (a.contextPct != null) bits.push(Math.round(a.contextPct) + '% context');
      if (a.costTodayUsd != null) bits.push('$' + a.costTodayUsd.toFixed(2) + ' today');
      if (a.deliveryPaused) bits.push('delivery paused');
      return el('div', { class: 'card' }, [
        el('div', { class: 'row' }, [
          el('span', { class: 'dot s-' + a.status }),
          el('span', { class: 'name', text: a.name }),
          el('span', { class: 'meta', text: STATUS[a.status] || a.status })
        ]),
        el('div', { class: 'meta', text: bits.filter(Boolean).join(' · ') }),
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
        el('div', { class: 'name', text: q.taskTitle }),
        q.askedAt ? el('div', { class: 'meta', text: 'Asked ' + when(q.askedAt) }) : null,
        el('div', { class: 'q', text: q.q }),
        box,
        el('div', { class: 'row', style: 'margin-top:8px' }, [
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
        el('div', { class: 'name', text: a.name }),
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
      el('div', { style: 'height:8px' }), box,
      el('div', { class: 'row', style: 'margin-top:8px' }, [
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
        el('div', { class: 'meta', text: agentName(m.from) + ' → ' + agentName(m.to) + ' · ' + when(m.createdAt) }),
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
      var kids = [el('div', { class: 'row' }, [el('span', { class: 'dot s-' + a.status }),
        el('span', { class: 'name', text: a.name }), el('span', { class: 'meta', text: STATUS[a.status] || a.status })])];
      var c = confirming && confirming.id === a.id ? choices.filter(function (x) { return x.kind === confirming.kind; })[0] : null;
      if (c) {
        kids.push(el('div', { class: 'q', text: c.ask }));
        kids.push(el('div', { class: 'row' }, [
          el('button', { class: 'act ' + (c.kind === 'delivery' ? 'primary' : 'danger'), text: 'Yes, ' + c.label.toLowerCase(),
            onclick: function () {
              confirming = null;
              post('/api/agents/' + encodeURIComponent(a.id) + '/' + c.kind,
                c.kind === 'delivery' ? { paused: !a.deliveryPaused } : {}, 'act:' + a.id);
            } }),
          el('button', { class: 'act', text: 'Cancel', onclick: function () { confirming = null; render(); } })
        ]));
      } else {
        kids.push(el('div', { class: 'row', style: 'margin-top:8px' }, choices.map(function (x) {
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
      devs.appendChild(el('span', { class: 'row' }, [el('span', { class: 'dot d-' + d.state }), d.name + ' ' + d.state]));
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
  es.onopen = function () { conn.textContent = 'Live'; };
  es.onerror = function () { conn.textContent = 'Reconnecting…'; };
  render();
})();
</script>
</body>
</html>
`;
