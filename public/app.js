// Tribal Conquest - frontend logic
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let S = null;             // /api/state
let V = null;             // current own-village detail
let T = null;             // selected target village detail (map side panel)
let REP = null;           // reports payload
let currentVillageId = null;
let selectedTargetId = null;
let view = 'map';
let mapHash = '';
let lastUnread = null;
let sideBuiltFor = null;  // village id the side form was built for

const UNIT_ORDER = [];
let UNITS = {};
let BUILDINGS = {};
let MAP = 60;

// ---------------------------------------------------------------
// utils
// ---------------------------------------------------------------
async function api(path, opts) {
  try {
    const res = await fetch(path, {
      method: opts?.method || 'GET',
      headers: opts?.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    });
    return await res.json();
  } catch (e) {
    return { error: 'Cannot reach the game server.' };
  }
}

function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (d) parts.push(d + 'd');
  if (h || d) parts.push(h + 'h');
  parts.push(m + 'm');
  if (!d && !h && m < 2) parts.push(s + 's');
  return parts.join(' ');
}

function fmtGameTime(t) {
  const days = Math.floor(t / 86400);
  const hh = String(Math.floor((t % 86400) / 3600)).padStart(2, '0');
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  return `Day ${days} · ${hh}:${mm}`;
}

function fmtResObj(r) {
  return `wood ${Math.floor(r.wood)} · clay ${Math.floor(r.clay)} · iron ${Math.floor(r.iron)}`;
}

function fmtUnits(units) {
  const parts = [];
  for (const u of UNIT_ORDER) {
    if (units[u]) parts.push(`${units[u]} ${UNITS[u].name}${units[u] > 1 ? 's' : ''}`);
  }
  return parts.join(', ') || '—';
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

// ---------------------------------------------------------------
// polling
// ---------------------------------------------------------------
async function refreshState() {
  const s = await api('/api/state');
  if (s.error) { toast(s.error); return; }
  S = s;
  UNITS = s.constants.UNITS;
  BUILDINGS = s.constants.BUILDINGS;
  MAP = s.constants.MAP_SIZE;
  if (UNIT_ORDER.length === 0) UNIT_ORDER.push(...Object.keys(UNITS));

  if (!currentVillageId || !S.myVillages.find((v) => v.id === currentVillageId)) {
    currentVillageId = S.myVillages.length ? S.myVillages[0].id : null;
    V = null;
  }

  if (lastUnread !== null && S.unread > lastUnread) toast('📜 New report');
  lastUnread = S.unread;

  $('#defeat-banner').classList.toggle('hidden', !S.defeated);
}

async function poll() {
  await refreshState();
  renderClock();
  renderBadge();

  if (view === 'map') {
    renderMap();
    await pollSide();
  } else if (view === 'village') {
    renderVillagePills();
    if (currentVillageId) {
      const v = await api('/api/village/' + currentVillageId);
      if (v.error) { V = null; $('#village-detail').innerHTML = ''; }
      else V = v;
      renderVillage();
    }
  } else if (view === 'reports') {
    const r = await api('/api/reports');
    if (!r.error) REP = r;
    renderReports();
  } else if (view === 'world') {
    renderWorld();
  }
}

// ---------------------------------------------------------------
// header / nav
// ---------------------------------------------------------------
function renderClock() {
  if (!S) return;
  const diffLabel = S.constants.DIFFICULTY[S.difficulty] || S.difficulty;
  $('#clock').textContent = `${fmtGameTime(S.game_time)} · ${diffLabel}`;
  for (const btn of $$('.speed-btn')) {
    btn.classList.toggle('active', Number(btn.dataset.speed) === S.speed);
  }
}

function renderBadge() {
  if (!S) return;
  const b = $('#unread-badge');
  b.textContent = S.unread;
  b.classList.toggle('hidden', S.unread <= 0);
}

function setView(name) {
  view = name;
  for (const tab of $$('.tab')) tab.classList.toggle('active', tab.dataset.view === name);
  $('#view-map').classList.toggle('hidden', name !== 'map');
  $('#view-village').classList.toggle('hidden', name !== 'village');
  $('#view-reports').classList.toggle('hidden', name !== 'reports');
  $('#view-world').classList.toggle('hidden', name !== 'world');
  if (name === 'village' && !currentVillageId && S && S.myVillages.length) {
    currentVillageId = S.myVillages[0].id;
  }
  poll();
}

// ---------------------------------------------------------------
// map view
// ---------------------------------------------------------------
let mapCells = [];
let mapBuilt = false;

function buildMapGrid() {
  const el = $('#map');
  el.innerHTML = '';
  mapCells = [];
  const frag = document.createDocumentFragment();
  for (let y = 0; y < MAP; y++) {
    for (let x = 0; x < MAP; x++) {
      const c = document.createElement('div');
      c.className = 'cell';
      c.dataset.x = x;
      c.dataset.y = y;
      frag.appendChild(c);
      mapCells.push(c);
    }
  }
  el.appendChild(frag);
  mapBuilt = true;
}

function renderMap() {
  if (!S) return;
  if (!mapBuilt || mapCells.length !== MAP * MAP) buildMapGrid();
  const hash = JSON.stringify({ sel: selectedTargetId, villages: S.villages.map((v) => [v.id, v.owner_id, v.x, v.y, v.points, v.loyalty]) });
  if (hash === mapHash) return;
  mapHash = hash;

  const byCoord = {};
  const mineIds = new Set(S.myVillages.map((v) => v.id));
  for (const v of S.villages) byCoord[v.x + ',' + v.y] = v;

  for (let i = 0; i < mapCells.length; i++) {
    const c = mapCells[i];
    const x = i % MAP;
    const y = Math.floor(i / MAP);
    const v = byCoord[x + ',' + y];
    let cls = 'cell';
    let title = `(${x}|${y})`;
    if (v) {
      if (v.owner_id === null) cls += ' barb';
      else if (mineIds.has(v.id)) cls += ' mine';
      else {
        const p = S.players.find((pl) => pl.id === v.owner_id);
        if (p && p.is_human) cls += ' human';
        else cls += ' ai ai-' + v.owner_id;
      }
      if (selectedTargetId === v.id) cls += ' selected';
      title = `${v.name} (${x}|${y}) — ${v.points} pts · loyalty ${v.loyalty}`;
    }
    if (c.className !== cls) c.className = cls;
    if (c.title !== title) c.title = title;
  }
}

function onMapClick(e) {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  const x = Number(cell.dataset.x);
  const y = Number(cell.dataset.y);
  const v = S.villages.find((v) => v.x === x && v.y === y);
  selectedTargetId = v ? v.id : null;
  mapHash = '';
  sideBuiltFor = null;
  renderMap();
  pollSide();
}

async function pollSide() {
  if (!selectedTargetId) {
    T = null;
    if (sideBuiltFor !== null) {
      $('#side-content').innerHTML = '<p class="hint">Click a village on the map to inspect it or attack it.</p>';
      sideBuiltFor = null;
    }
    return;
  }
  const t = await api('/api/village/' + selectedTargetId);
  if (t.error) return;
  T = t;
  if (sideBuiltFor !== T.id) {
    sideBuiltFor = T.id;
    renderSideFull();
  } else {
    updateSideDynamic();
  }
}

function renderSideFull() {
  const el = $('#side-content');
  if (!T) return;
  const ownerLine = T.own
    ? 'Your village'
    : T.owner_id === null ? 'Barbarian village' : `Village of ${T.owner_name}`;
  const loy = T.loyalty < 100 ? ` · loyalty <b>${T.loyalty}</b>` : '';

  let html = `
    <h2>${esc(T.name)}</h2>
    <div class="owner-line">${ownerLine} · (${T.x}|${T.y}) · ${T.points} pts${loy}</div>
    <div class="dist-list" id="dist-list"></div>
    <div id="scout-info"></div>`;

  if (T.own) {
    html += `<button class="btn" id="side-open-village">Open in Village tab</button>`;
  } else {
    html += sendFormHtml();
  }
  html += '<div id="side-msg"></div>';
  el.innerHTML = html;

  if (T.own) {
    $('#side-open-village').addEventListener('click', () => {
      currentVillageId = T.id;
      setView('village');
    });
  } else {
    wireSendForm();
  }
  updateSideDynamic();
}

function updateSideDynamic() {
  if (!T || !S) return;
  const distEl = $('#dist-list');
  if (distEl) {
    const parts = S.myVillages.map((mv) => {
      const d = Math.sqrt((mv.x - T.x) ** 2 + (mv.y - T.y) ** 2);
      const hours = d / 18; // reference: spear speed
      return `${esc(mv.name)}: ${d.toFixed(1)} fields (~${fmtDur(hours * 3600)} by foot)`;
    });
    distEl.innerHTML = parts.join('<br>');
  }
  const scoutEl = $('#scout-info');
  if (scoutEl) {
    if (T.scout && T.scout.troops) {
      const ago = fmtDur(Math.max(0, T.game_time - T.scout.at));
      scoutEl.innerHTML = `<div class="panel" style="margin-top:8px"><b>Scouting report</b> (${ago} ago):<br>${esc(fmtUnits(T.scout.troops))}</div>`;
    } else {
      scoutEl.innerHTML = '<div class="small">No scouting information. Send scouts to see the garrison.</div>';
    }
  }
  updateTravelInfo();
}

function sendFormHtml() {
  const opts = S.myVillages.map((mv) => `<option value="${mv.id}">${esc(mv.name)}</option>`).join('');
  let unitRows = '';
  for (const u of UNIT_ORDER) {
    unitRows += `
      <div class="send-row">
        <label for="af-unit-${u}">${UNITS[u].name}${UNITS[u].upkeep > 10 ? ' ⭐' : ''}</label>
        <input type="number" id="af-unit-${u}" min="0" value="0">
        <span class="small" id="af-max-${u}"></span>
      </div>`;
  }
  return `
    <div class="panel" style="margin-top:10px">
      <b>Send a mission</b>
      <div class="send-row">
        <label for="af-from">From</label>
        <select id="af-from">${opts}</select>
      </div>
      <div class="kind-row">
        <label><input type="radio" name="af-kind" value="attack" checked> Attack (fight + loot)</label>
        <label><input type="radio" name="af-kind" value="raid"> Raid (loot, retreat if too strong)</label>
        <label><input type="radio" name="af-kind" value="scout"> Scout</label>
      </div>
      ${unitRows}
      <div class="travel-info" id="travel-info"></div>
      <button class="btn primary" id="send-btn">Send troops</button>
    </div>`;
}

function wireSendForm() {
  $('#af-from').addEventListener('change', () => { updateMaxes(); updateTravelInfo(); });
  for (const u of UNIT_ORDER) {
    $('#af-unit-' + u).addEventListener('input', () => { clampInput(u); updateTravelInfo(); });
  }
  for (const r of $$('input[name="af-kind"]')) {
    r.addEventListener('change', () => { updateKindState(); updateTravelInfo(); });
  }
  $('#send-btn').addEventListener('click', sendTroops);
  updateMaxes();
  updateKindState();
}

function selectedFrom() {
  const id = Number($('#af-from')?.value);
  return S.myVillages.find((v) => v.id === id);
}

function maxAvail(unit) {
  const from = selectedFrom();
  return (from && from.available[unit]) || 0;
}

function updateMaxes() {
  for (const u of UNIT_ORDER) {
    const el = $('#af-max-' + u);
    if (el) el.textContent = `/ ${maxAvail(u)} available`;
  }
}

function clampInput(u) {
  const el = $('#af-unit-' + u);
  let n = parseInt(el.value, 10) || 0;
  if (n < 0) n = 0;
  if (n > maxAvail(u)) n = maxAvail(u);
  el.value = n;
}

function updateKindState() {
  const kind = ($('input[name="af-kind"]:checked') || {}).value || 'attack';
  for (const u of UNIT_ORDER) {
    const el = $('#af-unit-' + u);
    if (!el) continue;
    const disabled = (kind === 'scout' && u !== 'scout') || (kind === 'raid' && u === 'noble');
    el.disabled = disabled;
    if (disabled) el.value = 0;
  }
}

function selectedSendUnits() {
  const units = {};
  for (const u of UNIT_ORDER) {
    const n = parseInt($('#af-unit-' + u)?.value, 10) || 0;
    if (n > 0) units[u] = n;
  }
  return units;
}

function updateTravelInfo() {
  const el = $('#travel-info');
  if (!el || !T) return;
  const from = selectedFrom();
  if (!from) { el.textContent = ''; return; }
  const units = selectedSendUnits();
  const keys = Object.keys(units).filter((u) => units[u] > 0);
  if (!keys.length) { el.textContent = ''; return; }
  const speed = Math.min(...keys.map((u) => UNITS[u].speed));
  const dist = Math.sqrt((from.x - T.x) ** 2 + (from.y - T.y) ** 2);
  const dur = (dist / speed) * 3600;
  el.textContent = `Distance ${dist.toFixed(1)} fields · travel ≈ ${fmtDur(dur)} · arrival ≈ ${fmtGameTime(S.game_time + dur)}`;
}

async function sendTroops() {
  const from = selectedFrom();
  if (!from) return;
  const kind = ($('input[name="af-kind"]:checked') || {}).value || 'attack';
  const units = selectedSendUnits();
  if (!Object.keys(units).length) { sideMsg('Select at least one unit.'); return; }
  const res = await api(`/api/village/${from.id}/send`, {
    method: 'POST',
    body: { to_id: T.id, kind, units },
  });
  if (res.error) { sideMsg(res.error); return; }
  toast(`⚔ ${kind === 'scout' ? 'Scouts' : 'Troops'} sent — arrive in ${fmtDur((res.arrive - S.game_time))}`);
  sideMsg('');
  await refreshState();
  await pollSide();
}

function sideMsg(msg) {
  const el = $('#side-msg');
  if (el) el.innerHTML = msg ? `<div class="error-box">${esc(msg)}</div>` : '';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------
// village view
// ---------------------------------------------------------------
function renderVillagePills() {
  if (!S) return;
  const el = $('#village-select');
  if (!S.myVillages.length) {
    el.innerHTML = '<span class="small">You have no villages.</span>';
    return;
  }
  el.innerHTML = S.myVillages.map((v) =>
    `<button class="village-pill ${v.id === currentVillageId ? 'active' : ''}" data-vid="${v.id}">${esc(v.name)} (${v.x}|${v.y})</button>`
  ).join('');
  for (const btn of el.querySelectorAll('.village-pill')) {
    btn.addEventListener('click', () => {
      currentVillageId = Number(btn.dataset.vid);
      V = null;
      renderVillagePills();
      poll();
    });
  }
}

const trainInputs = {}; // villageId -> {unit: count}

function renderVillage() {
  if (!S || !V) {
    $('#village-detail').innerHTML = S && !S.myVillages.length
      ? '<div class="panel">You have no villages left. Start a new world from the World tab.</div>'
      : '';
    return;
  }
  const g = S.game_time;

  // ---- resources ----
  let html = `
    <div class="village-head">${esc(V.name)} <span class="small">(${V.x}|${V.y})</span></div>
    <div class="village-sub">${V.points} points${V.loyalty < 100 ? ` · loyalty <b style="color:var(--bad)">${V.loyalty}</b>` : ''} · storage ${V.caps.store.toLocaleString()}</div>
    <div class="panel">
      <h2>Resources</h2>
      <div class="res-grid">
        <div class="res-item"><div class="res-name">Wood</div><div class="res-val">${Math.floor(V.res.wood).toLocaleString()}</div><div class="res-rate">${V.rates.wood}/h</div></div>
        <div class="res-item"><div class="res-name">Clay</div><div class="res-val">${Math.floor(V.res.clay).toLocaleString()}</div><div class="res-rate">${V.rates.clay}/h</div></div>
        <div class="res-item"><div class="res-name">Iron</div><div class="res-val">${Math.floor(V.res.iron).toLocaleString()}</div><div class="res-rate">${V.rates.iron}/h</div></div>
        <div class="res-item"><div class="res-name">Wheat</div><div class="res-val">${Math.floor(V.res.wheat).toLocaleString()}</div><div class="res-rate ${V.rates.wheatNet < 0 ? 'neg' : ''}">${V.rates.wheatNet}/h net</div></div>
      </div>
    </div>`;

  // ---- buildings ----
  html += '<div class="panel"><h2>Buildings</h2>';
  const bq = V.build_queue[0];
  if (bq) {
    const remain = bq.end - g;
    const span = Math.max(1, bq.end - (bq.start ?? bq.end - 1));
    const pct = Math.max(0, Math.min(100, Math.round(100 * (1 - remain / span))));
    html += `
      <div>
        Building <b>${esc(BUILDINGS[bq.type].name)}</b> to level ${bq.level} — <b>${fmtDur(remain)}</b> left
        <button class="btn danger" id="cancel-build">Cancel</button>
        <div class="progress" style="width:260px"><div style="width:${pct}%"></div></div>
      </div>`;
  } else {
    html += '<div class="small">Build queue empty.</div>';
  }
  html += '<table><tr><th>Building</th><th>Level</th><th>Next level cost</th><th>Build time</th><th></th></tr>';
  const order = ['hq', 'barracks', 'stable', 'workshop', 'academy', 'farm', 'warehouse', 'wall', 'rally', 'smithy', 'wood', 'clay', 'iron'];
  const buildable = {};
  for (const b of V.buildable) buildable[b.type] = b;
  for (const type of order) {
    const bdef = BUILDINGS[type];
    const lvl = V.buildings[type] || 0;
    const b = buildable[type];
    const queueBusy = V.build_queue.length > 0;
    let btn, cost, time, disabled = false, title = '';
    if (!b) {
      btn = 'MAX';
      cost = '—';
      time = '—';
      disabled = true;
    } else {
      cost = fmtResObj(b.cost);
      time = fmtDur(b.time);
      if (queueBusy) { btn = 'Busy'; disabled = true; title = 'Build queue busy'; }
      else if (!b.reqMet) { btn = 'Req'; disabled = true; title = `Requires: ${describeReqs(bdef.req)}`; }
      else { btn = 'Upgrade'; }
    }
    const titleAttr = (title || bdef.desc) ? ` title="${esc(title || bdef.desc)}"` : '';
    html += `<tr class="build-row"><td${titleAttr}>${esc(bdef.name)}</td><td>${lvl}<span class="small">/${bdef.max}</span></td><td class="cost">${cost}</td><td class="cost">${time}</td>
      <td><button class="btn" data-build="${type}" ${disabled ? 'disabled' : ''}>${btn}</button></td></tr>`;
  }
  html += '</table></div>';

  // ---- recruitment ----
  html += '<div class="panel"><h2>Recruitment</h2>';
  const tq = V.train_queue[0];
  if (tq) {
    html += `<div>Training <b>${tq.count} ${UNITS[tq.unit].name}${tq.count > 1 ? 's' : ''}</b> — <b>${fmtDur(tq.end - g)}</b> left <button class="btn danger" id="cancel-train">Cancel</button></div>`;
  } else {
    html += '<div class="small">Nothing in training.</div>';
  }
  const groups = [
    ['Barracks', ['spear', 'sword', 'axe', 'archer']],
    ['Stable', ['scout', 'lcav']],
    ['Workshop', ['ram']],
    ['Academy', ['noble']],
  ];
  const trainable = {};
  for (const t of V.trainable) trainable[t.unit] = t;
  for (const [gname, units] of groups) {
    html += `<h3 style="color:var(--dim);margin:10px 0 4px 0">${gname}</h3><table><tr><th>Unit</th><th>Cost each</th><th>Time</th><th>Stationed</th><th>Train</th></tr>`;
    for (const u of units) {
      const udef = UNITS[u];
      const t = trainable[u];
      const have = V.troops[u] || 0;
      let disabled = false, title = '';
      if (t.buildingLevel < 1) { disabled = true; title = `Requires ${gname} level 1`; }
      else if (!t.reqMet) { disabled = true; title = `Requires: ${describeReqs(udef.req)}`; }
      const inp = trainInputs[currentVillageId]?.[u] || '';
      html += `<tr class="unit-row">
        <td${title ? ` title="${esc(title)}"` : ''}>${esc(udef.name)} <span class="small">${title ? '· 🔒' : ''}</span></td>
        <td class="cost">${fmtResObj(udef.cost)}</td>
        <td class="cost">${fmtDur(udef.time)}</td>
        <td>${have.toLocaleString()}</td>
        <td><input type="number" min="0" value="${inp}" data-train-input="${u}" style="width:80px"> <button class="btn" data-train="${u}" ${disabled ? 'disabled' : ''}>Train</button></td>
      </tr>`;
    }
    html += '</table>';
  }
  html += '</div>';

  // ---- troops & missions ----
  html += '<div class="panel"><h2>Troops &amp; Missions</h2>';
  html += '<table><tr><th>Unit</th><th>Stationed</th><th>Available</th><th>Out</th></tr>';
  for (const u of UNIT_ORDER) {
    const have = V.troops[u] || 0;
    const avail = V.available[u] || 0;
    const out = have - avail;
    html += `<tr><td>${esc(UNITS[u].name)}</td><td class="num">${have.toLocaleString()}</td><td class="num">${avail.toLocaleString()}</td><td class="num">${out.toLocaleString()}</td></tr>`;
  }
  html += '</table>';
  if (V.outgoing.length) {
    html += '<div style="margin-top:8px"><b>Outgoing:</b></div>';
    for (const m of V.outgoing) {
      html += `<div class="small">→ ${m.kind} to ${esc(m.to_name)} (${m.to_x}|${m.to_y}): ${esc(fmtUnits(m.units))} · arrives in ${fmtDur(m.arrive - g)}</div>`;
    }
  }
  if (V.incoming.length) {
    html += '<div style="margin-top:8px"><b style="color:var(--bad)">Incoming:</b></div>';
    for (const m of V.incoming) {
      html += `<div class="small" style="color:var(--bad)">⚠ ${m.kind} from (${m.from_x}|${m.from_y}) · arrives in ${fmtDur(m.arrive - g)}</div>`;
    }
  }
  html += '</div>';

  $('#village-detail').innerHTML = html;

  // wire up
  const cancelBuild = $('#cancel-build');
  if (cancelBuild) cancelBuild.addEventListener('click', () => actVillage('cancel-build'));
  const cancelTrain = $('#cancel-train');
  if (cancelTrain) cancelTrain.addEventListener('click', () => actVillage('cancel-train'));
  for (const btn of $$('[data-build]')) {
    btn.addEventListener('click', () => api(`/api/village/${V.id}/build`, { method: 'POST', body: { type: btn.dataset.build } })
      .then((r) => { if (r.error) toast(r.error); else toast('🏗 Construction started'); poll(); }));
  }
  for (const btn of $$('[data-train]')) {
    btn.addEventListener('click', () => {
      const u = btn.dataset.train;
      const count = Number($(`[data-train-input="${u}"]`).value) || 0;
      if (count <= 0) { toast('Enter how many to train.'); return; }
      api(`/api/village/${V.id}/train`, { method: 'POST', body: { unit: u, count } })
        .then((r) => { if (r.error) toast(r.error); else toast(`⚒ Training ${count} ${UNITS[u].name}${count > 1 ? 's' : ''}`); poll(); });
    });
  }
  for (const inp of $$('[data-train-input]')) {
    inp.addEventListener('input', () => {
      if (!trainInputs[currentVillageId]) trainInputs[currentVillageId] = {};
      trainInputs[currentVillageId][inp.dataset.trainInput] = inp.value;
    });
  }
}

async function actVillage(action) {
  const res = await api(`/api/village/${V.id}/${action}`, { method: 'POST', body: {} });
  if (res.error) toast(res.error);
  else toast('Done.');
  poll();
}

function describeReqs(reqs) {
  if (!reqs || !Object.keys(reqs).length) return 'nothing';
  return Object.entries(reqs).map(([b, l]) => `${BUILDINGS[b].name} level ${l}`).join(', ');
}

// ---------------------------------------------------------------
// reports view
// ---------------------------------------------------------------
function renderReports() {
  if (!S || !REP) return;
  const list = $('#reports-list');
  if (!REP.reports.length) {
    list.innerHTML = '<div class="panel">No reports yet. Send your troops out to make history.</div>';
    return;
  }
  list.innerHTML = REP.reports.map((r) => `
    <div class="report ${r.read ? '' : 'unread'}" data-rid="${r.id}">
      <span class="kind-tag">${r.kind}</span>
      <span class="rep-title">${esc(r.title)}</span>
      <div class="rep-meta">${fmtDur(Math.max(0, S.game_time - r.at))} ago</div>
      <div class="rep-body">${esc(r.body)}</div>
    </div>`).join('');
  for (const el of list.querySelectorAll('.report')) {
    el.addEventListener('click', () => el.classList.toggle('open'));
  }
}

// ---------------------------------------------------------------
// world view
// ---------------------------------------------------------------
function renderWorld() {
  if (!S) return;
  const el = $('#world-panel');
  el.innerHTML = `
    <div class="panel">
      <h2>World</h2>
      <div class="row"><label>Game time</label>${fmtGameTime(S.game_time)}</div>
      <div class="row"><label>Difficulty</label>${esc(S.constants.DIFFICULTY[S.difficulty])}</div>
      <div class="row"><label>Players</label>${S.players.map((p) => `<span style="color:${p.color}">●</span> ${esc(p.name)}${p.is_human ? ' (you)' : ''}`).join(' · ')}</div>
      <div class="row"><label>Map</label>${MAP}×${MAP} fields, ${S.villages.length} villages</div>
    </div>
    <div class="panel">
      <h2>Game speed</h2>
      <div class="row">
        <div class="speed-wrap">
          ${S.constants.SPEEDS.map((sp) => `<button class="speed-btn ${sp === S.speed ? 'active' : ''}" data-speed="${sp}">${sp === 0 ? '⏸ Pause' : sp + '×'}</button>`).join('')}
        </div>
      </div>
      <div class="small">Since this is singleplayer, crank it to 100× to skip waiting. The AI plays by the same rules.</div>
    </div>
    <div class="panel">
      <h2>New game</h2>
      <div class="row">
        <label for="new-difficulty">Difficulty</label>
        <select id="new-difficulty">
          ${Object.entries(S.constants.DIFFICULTY).map(([k, label]) => `<option value="${k}" ${k === S.difficulty ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select>
        <button class="btn danger" id="new-game-btn">Start new world</button>
      </div>
      <div class="small">This erases the current world and generates a fresh map.</div>
    </div>
    ${S.cheats ? `
    <div class="panel">
      <h2>Cheats (dev)</h2>
      <div class="row">
        <label>+10k each resource</label>
        <button class="btn" id="cheat-btn">Add to current village</button>
      </div>
    </div>` : ''}
  `;

  for (const btn of el.querySelectorAll('.speed-btn')) {
    btn.addEventListener('click', () => {
      api('/api/settings', { method: 'POST', body: { speed: Number(btn.dataset.speed) } })
        .then((r) => { if (!r.error) { S.speed = r.speed; renderClock(); } });
    });
  }
  const ng = $('#new-game-btn');
  if (ng) ng.addEventListener('click', () => {
    if (!confirm('Start a new world? This erases your current progress.')) return;
    const difficulty = $('#new-difficulty').value;
    api('/api/world/new', { method: 'POST', body: { difficulty } })
      .then(async (r) => {
        if (r.error) { toast(r.error); return; }
        toast('🌍 New world generated');
        currentVillageId = null;
        selectedTargetId = null;
        mapHash = '';
        sideBuiltFor = null;
        await refreshState();
        poll();
      });
  });
  const cheat = $('#cheat-btn');
  if (cheat) cheat.addEventListener('click', () => {
    if (!currentVillageId) return;
    api('/api/cheat', { method: 'POST', body: { village_id: currentVillageId, wood: 10000, clay: 10000, iron: 10000, wheat: 10000 } })
      .then((r) => { if (r.error) toast(r.error); else toast('💰 +10k resources'); poll(); });
  });
}

// ---------------------------------------------------------------
// boot
// ---------------------------------------------------------------
function wireGlobal() {
  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => setView(tab.dataset.view));
  }
  for (const btn of $$('header .speed-btn')) {
    btn.addEventListener('click', () => {
      api('/api/settings', { method: 'POST', body: { speed: Number(btn.dataset.speed) } })
        .then((r) => { if (!r.error) { S.speed = r.speed; renderClock(); } });
    });
  }
  $('#map').addEventListener('click', onMapClick);
  $('#mark-all-read').addEventListener('click', async () => {
    await api('/api/reports/read-all', { method: 'POST', body: {} });
    const r = await api('/api/reports');
    if (!r.error) REP = r;
    await refreshState();
    renderBadge();
    renderReports();
  });
  $('#defeat-new-game').addEventListener('click', () => setView('world'));
}

(async function boot() {
  wireGlobal();
  await refreshState();
  if (!S) return;
  setView('map');
  setInterval(poll, 2000);
})();
