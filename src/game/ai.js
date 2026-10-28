// AI opponents: each AI player runs a state machine over its villages.
// Decisions are made once per game hour per player (staggered naturally by id).
const C = require('./constants');
const db = require('./db');
const combat = require('./combat');

const HOUR = C.GAME_HOUR;

const BUILD_ORDER = ['wood', 'clay', 'iron', 'farm', 'warehouse', 'hq', 'barracks', 'smithy', 'wall', 'stable', 'workshop', 'academy'];

function getState(playerId) {
  return db.getSetting(`ai_state_${playerId}`, {}) || {};
}
function saveState(playerId, state) {
  db.setSetting(`ai_state_${playerId}`, state);
}

// Called every tick; throttles itself to one decision round per game hour.
function aiDecide(player, ctx) {
  const state = getState(player.id);
  if (ctx.game_time - (state.last_decision || 0) < HOUR) return;
  state.last_decision = ctx.game_time;

  const diff = C.DIFFICULTY[player.difficulty] || C.DIFFICULTY.normal;
  const myVillages = db.villages().filter((r) => r.owner_id === player.id);

  for (const v of myVillages) {
    try { aiBuild(v, diff, ctx); } catch (e) { /* keep going */ }
    try { aiTrain(player, v, diff, state, ctx); } catch (e) { /* keep going */ }
    try { aiFarm(player, v, diff, state, ctx); } catch (e) { /* keep going */ }
    try { aiExpand(player, v, diff, state, ctx); } catch (e) { /* keep going */ }
    try { aiRetaliate(player, v, diff, state, ctx); } catch (e) { /* keep going */ }
  }
  saveState(player.id, state);
}

// ---- economy: upgrade the cheapest affordable building under its target ----
function aiBuild(v, diff, ctx) {
  if (v.build_queue.length) return;
  const econ = diff.econFactor;
  const targets = {
    wood: Math.round(12 * econ), clay: Math.round(12 * econ), iron: Math.round(12 * econ),
    farm: Math.round(10 * econ), warehouse: Math.round(12 * econ), hq: Math.round(12 * econ),
    barracks: 10, smithy: 6, wall: 10, stable: 8, workshop: 3, academy: 1,
  };
  const candidates = [];
  for (const type of BUILD_ORDER) {
    const lvl = v.buildings[type] || 0;
    if (lvl >= Math.min(targets[type], C.BUILDINGS[type].max)) continue;
    if (!ctx.reqsMet(v, C.BUILDINGS[type].req)) continue;
    const cost = ctx.buildingCost(type, lvl);
    if (ctx.canAfford(v, cost)) {
      candidates.push({ type, total: cost.wood + cost.clay + cost.iron });
    }
  }
  if (!candidates.length) return;
  candidates.sort((a, b) => a.total - b.total);
  const type = candidates[0].type;
  const lvl = v.buildings[type] || 0;
  ctx.pay(v, ctx.buildingCost(type, lvl));
  v.build_queue.push({ type, level: lvl + 1, start: ctx.game_time, end: ctx.game_time + ctx.buildingTime(type, lvl, v.buildings.hq || 1) });
  db.saveVillage(v);
}

// ---- military: maintain garrison + offensive army, train nobles ----
function aiTrain(player, v, diff, state, ctx) {
  if (v.train_queue.length) return;

  // wheat trouble? pause recruitment
  const rates = ctx.productionRates(v);
  if (rates.wheat - ctx.wheatUpkeep(v) < 0 && v.res.wheat < 2000) return;

  const ageDays = ctx.game_time / C.GAME_DAY;
  const garrisonTarget = Math.round((80 + ageDays * 14) * diff.armyFactor);
  const offTarget = Math.round((140 + ageDays * 20) * diff.armyFactor);

  const troops = v.troops;
  const garrison = (troops.spear || 0) + (troops.sword || 0) + (troops.archer || 0);
  const off = (troops.axe || 0) + (troops.lcav || 0);

  // noblemen have top priority once the academy exists
  if ((v.buildings.academy || 0) >= 1) {
    const queued = v.train_queue.reduce((a, j) => a + (j.unit === 'noble' ? j.count : 0), 0);
    const nobles = (troops.noble || 0) + queued;
    if (nobles < 3) {
      if (queueBatch(v, 'noble', 1, ctx)) return;
    }
  }

  if (garrison < garrisonTarget) {
    // rotate defensive unit types: spear mostly, then sword / archer
    const rot = (state.train_rot || 0) % 3;
    state.train_rot = (state.train_rot || 0) + 1;
    const unit = rot === 0 ? 'spear' : rot === 1 ? 'sword' : 'archer';
    if (queueBatch(v, unit, Math.max(10, garrisonTarget - garrison), ctx)) return;
  }
  if (off < offTarget) {
    const rot = (state.off_rot || 0) % 2;
    state.off_rot = (state.off_rot || 0) + 1;
    const unit = rot === 0 ? 'axe' : 'lcav';
    if (queueBatch(v, unit, Math.max(5, offTarget - off), ctx)) return;
  }
}

// Queue up to `want` of a unit, limited by what the AI can afford.
function queueBatch(v, unit, want, ctx) {
  const u = C.UNITS[unit];
  let n = Math.min(want, 200);
  n = Math.min(n, Math.floor(v.res.wood / u.cost.wood));
  n = Math.min(n, Math.floor(v.res.clay / u.cost.clay));
  n = Math.min(n, Math.floor(v.res.iron / u.cost.iron));
  if (n < 1) return false;
  ctx.pay(v, ctx.unitCost(unit, n));
  v.train_queue.push({ unit, count: n, start: ctx.game_time, end: ctx.game_time + u.time * n });
  db.saveVillage(v);
  return true;
}

// ---- farming: raid nearby barbarian villages for loot ----
function aiFarm(player, v, diff, state, ctx) {
  if (state.farm_cooldown && ctx.game_time < state.farm_cooldown) return;
  const avail = ctx.availableTroops(v);
  const offStr = combat.attackStrength(avail);
  if (offStr < 400 * diff.armyFactor) return;

  let target = null;
  let best = Infinity;
  for (const r of db.villages()) {
    if (r.owner_id !== null) continue;
    const d = ctx.distanceOf(v, r);
    if (d < best && d <= diff.farmRange) { best = d; target = r; }
  }
  if (!target) return;

  const units = {};
  if (avail.axe) units.axe = Math.max(1, Math.round(avail.axe * 0.5));
  if (avail.lcav) units.lcav = Math.max(1, Math.round(avail.lcav * 0.5));
  if (!Object.keys(units).length) return;
  try {
    ctx.sendArmy(player.id, v.id, target.id, 'raid', units);
    state.farm_cooldown = ctx.game_time + 4 * HOUR;
  } catch (e) { /* not enough troops etc. */ }
}

// ---- expansion: noble trains against barbarian villages (or the player) ----
function aiExpand(player, v, diff, state, ctx) {
  if (state.expand_cooldown && ctx.game_time < state.expand_cooldown) return;
  const avail = ctx.availableTroops(v);
  const nobles = avail.noble || 0;
  if (nobles < (player.difficulty === 'hard' ? 2 : 3)) return;
  const offStr = combat.attackStrength(avail);
  if (offStr < 2500 * diff.armyFactor) return;

  let target = null;
  let best = Infinity;
  for (const r of db.villages()) {
    if (r.owner_id !== null) continue;
    const d = ctx.distanceOf(v, r);
    if (d < best && d <= diff.expandRange) { best = d; target = r; }
  }

  // stronger AIs may go for the player's villages instead (after the grace period)
  if (!target && diff.attacksPlayer && ctx.game_time / C.GAME_HOUR >= diff.attackDelayHours) {
    const human = db.players().find((p) => p.is_human);
    const humanVillages = db.villages().filter((r) => r.owner_id === human.id);
    let playerDef = 0;
    for (const r of humanVillages) {
      playerDef += combat.defenseStrength(r.troops, {}, r.buildings.wall || 0);
    }
    if (offStr > playerDef * 1.2) {
      best = Infinity;
      for (const r of humanVillages) {
        const d = ctx.distanceOf(v, r);
        if (d < best && d <= diff.expandRange + 10) { best = d; target = r; }
      }
    }
  }
  if (!target) return;

  const units = {
    noble: Math.min(nobles, 3),
    axe: Math.min(avail.axe || 0, 120),
    lcav: Math.min(avail.lcav || 0, 30),
    ram: Math.min(avail.ram || 0, 5),
  };
  try {
    ctx.sendArmy(player.id, v.id, target.id, 'attack', units);
    state.expand_cooldown = ctx.game_time + 6 * HOUR;
  } catch (e) { /* ignore */ }
}

// ---- war: retaliation and opportunistic attacks on the human player ----
function aiRetaliate(player, v, diff, state, ctx) {
  if (!diff.attacksPlayer) return;
  const human = db.players().find((p) => p.is_human);
  if (!human) return;
  const humanVillages = db.villages().filter((r) => r.owner_id === human.id);
  if (!humanVillages.length) return;

  const avail = ctx.availableTroops(v);
  const offStr = combat.attackStrength(avail);
  const hoursIn = ctx.game_time / HOUR;
  if (offStr < 1200 * diff.armyFactor) return;

  const since = ctx.game_time - 24 * HOUR;
  const attackedByHuman = db.recentAttackReports(player.id, since)
    .some((r) => { const m = db.parse(r.meta); return m && m.attacker_id === human.id; });

  if (state.war_cooldown && ctx.game_time < state.war_cooldown) return;

  const wantWar = attackedByHuman || (hoursIn >= diff.attackDelayHours && Math.random() < 0.15);
  if (!wantWar) return;

  // only attack if we outmatch the player's defense
  let playerDef = 0;
  for (const r of humanVillages) {
    playerDef += combat.defenseStrength(r.troops, {}, r.buildings.wall || 0);
  }
  if (offStr < playerDef * 1.15) return;

  let target = null;
  let best = Infinity;
  for (const r of humanVillages) {
    const d = ctx.distanceOf(v, r);
    if (d < best) { best = d; target = r; }
  }
  if (!target) return;

  const units = {};
  for (const u of ['axe', 'lcav', 'ram']) {
    if (avail[u]) units[u] = Math.max(1, Math.round(avail[u] * 0.8));
  }
  if (!Object.keys(units).length) return;
  try {
    ctx.sendArmy(player.id, v.id, target.id, 'attack', units);
    state.war_cooldown = ctx.game_time + 12 * HOUR;
  } catch (e) { /* ignore */ }
}

module.exports = { aiDecide };
