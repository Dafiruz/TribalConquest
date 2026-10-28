// Game engine: world simulation, actions, and the API payload builders.
const C = require('./constants');
const db = require('./db');
const combat = require('./combat');
const { generateWorld } = require('./world');
const { aiDecide } = require('./ai');

const HOUR = C.GAME_HOUR;

// ============================================================
// helpers
// ============================================================
function now() { return db.getSetting('game_time', 0); }

// Villages come from the db layer already parsed (cached).

function pointsOf(v) {
  return Object.values(v.buildings).reduce((a, b) => a + b, 0);
}

function buildingCost(type, level) {
  const b = C.BUILDINGS[type];
  const f = Math.pow(b.factor, level);
  return {
    wood: Math.round(b.cost.wood * f),
    clay: Math.round(b.cost.clay * f),
    iron: Math.round(b.cost.iron * f),
  };
}

function buildingTime(type, level, hqLevel) {
  const b = C.BUILDINGS[type];
  const base = b.time * Math.pow(b.timeFactor, level);
  return Math.round(base / (1 + 0.08 * (hqLevel - 1))); // higher HQ builds faster
}

function warehouseCap(v) {
  return Math.round(C.WAREHOUSE_CAP.base * Math.pow(C.WAREHOUSE_CAP.growth, (v.buildings.warehouse || 0) - 1));
}

function productionRates(v) {
  const lvl = (t) => v.buildings[t] || 0;
  return {
    wood: Math.round(C.FIELD_PROD.base * Math.pow(C.FIELD_PROD.growth, lvl('wood') - 1) * 10) / 10,
    clay: Math.round(C.FIELD_PROD.base * Math.pow(C.FIELD_PROD.growth, lvl('clay') - 1) * 10) / 10,
    iron: Math.round(C.FIELD_PROD.base * Math.pow(C.FIELD_PROD.growth, lvl('iron') - 1) * 10) / 10,
    wheat: Math.round(C.FARM_PROD.base * Math.pow(C.FARM_PROD.growth, lvl('farm') - 1) * 10) / 10,
  };
}

function wheatUpkeep(v) {
  let u = 0;
  for (const [unit, n] of Object.entries(v.troops)) u += (C.UNITS[unit].upkeep || 0) * n;
  return u;
}

function distanceOf(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

// Troops currently stationed minus troops already on missions.
function availableTroops(v) {
  const avail = { ...v.troops };
  for (const mv of db.movements()) {
    if (mv.from_id !== v.id || mv.kind === 'return') continue;
    for (const [u, n] of Object.entries(db.parse(mv.units) || {})) {
      avail[u] = (avail[u] || 0) - n;
    }
  }
  for (const u of Object.keys(avail)) if (avail[u] <= 0) delete avail[u];
  return avail;
}

function canAfford(v, cost) {
  return (v.res.wood >= cost.wood && v.res.clay >= cost.clay && v.res.iron >= cost.iron);
}

function pay(v, cost) {
  v.res.wood -= cost.wood; v.res.clay -= cost.clay; v.res.iron -= cost.iron;
}

function reqsMet(v, reqs) {
  for (const [b, lvl] of Object.entries(reqs || {})) {
    if ((v.buildings[b] || 0) < lvl) return false;
  }
  return true;
}

function unitCost(unit, count) {
  const c = C.UNITS[unit].cost;
  return { wood: c.wood * count, clay: c.clay * count, iron: c.iron * count };
}

function fmtUnits(units) {
  const parts = [];
  for (const u of C.UNIT_ORDER) {
    if (units[u]) parts.push(`${units[u]} ${C.UNITS[u].name}${units[u] > 1 ? 's' : ''}`);
  }
  return parts.join(', ') || 'nothing';
}

function fmtRes(res) {
  return `wood ${Math.floor(res.wood)} · clay ${Math.floor(res.clay)} · iron ${Math.floor(res.iron)}`;
}

// ============================================================
// village updates (called every tick)
// ============================================================
function updateVillage(v, dt, gameTime) {
  let changed = false;

  // resource production & storage caps
  const rates = productionRates(v);
  const cap = warehouseCap(v);
  const wheatNet = rates.wheat - wheatUpkeep(v);
  const fields = [
    ['wood', rates.wood], ['clay', rates.clay], ['iron', rates.iron],
  ];
  for (const [res, rate] of fields) {
    const cur = v.res[res];
    // production stops at the storage cap but never destroys stock already above it
    // (e.g. from build refunds or dev cheats)
    const next = cur > cap ? cur : Math.min(cap, cur + (rate * dt) / HOUR);
    if (Math.abs(next - cur) > 0.001) { v.res[res] = next; changed = true; }
  }
  const nextWheat = Math.max(0, v.res.wheat + (wheatNet * dt) / HOUR);
  if (Math.abs(nextWheat - v.res.wheat) > 0.001) { v.res.wheat = nextWheat; changed = true; }

  // build queue
  const bq = v.build_queue;
  if (bq.length && gameTime >= bq[0].end) {
    const job = bq.shift();
    v.buildings[job.type] = job.level;
    changed = true;
  }

  // training queue
  const tq = v.train_queue;
  if (tq.length && gameTime >= tq[0].end) {
    const job = tq.shift();
    v.troops[job.unit] = (v.troops[job.unit] || 0) + job.count;
    changed = true;
  }

  if (changed) db.saveVillage(v);
}

// ============================================================
// actions (validated, throw Error(message) on failure)
// ============================================================
function actionBuild(playerId, villageId, type) {
  const v = getOwnVillage(playerId, villageId);
  const b = C.BUILDINGS[type];
  if (!b) throw new Error('Unknown building.');
  const level = v.buildings[type] || 0;
  if (level >= b.max) throw new Error(`${b.name} is already at maximum level.`);
  if (v.build_queue.length > 0) throw new Error('Your building queue is busy.');
  if (!reqsMet(v, b.req)) throw new Error(`Requires ${describeReqs(b.req)}.`);
  const cost = buildingCost(type, level);
  if (!canAfford(v, cost)) throw new Error(`Not enough resources. Need ${fmtRes(cost)}.`);
  pay(v, cost);
  const time = buildingTime(type, level, v.buildings.hq || 1);
  v.build_queue.push({ type, level: level + 1, start: now(), end: now() + time });
  db.saveVillage(v);
  return { ok: true, time };
}

function actionCancelBuild(playerId, villageId) {
  const v = getOwnVillage(playerId, villageId);
  const job = v.build_queue[0];
  if (!job) throw new Error('Nothing is being built.');
  const cost = buildingCost(job.type, job.level - 1);
  v.res.wood += cost.wood; v.res.clay += cost.clay; v.res.iron += cost.iron;
  v.build_queue = [];
  db.saveVillage(v);
  return { ok: true };
}

function actionTrain(playerId, villageId, unit, count) {
  const v = getOwnVillage(playerId, villageId);
  const u = C.UNITS[unit];
  if (!u) throw new Error('Unknown unit.');
  count = Math.max(1, Math.floor(count));
  if (count > 10000) throw new Error('Too many at once.');
  if (!reqsMet(v, u.req)) throw new Error(`Requires ${describeReqs(u.req)}.`);
  if ((v.buildings[u.from] || 0) < 1) throw new Error(`Requires a ${C.BUILDINGS[u.from].name}.`);
  const cost = unitCost(unit, count);
  if (!canAfford(v, cost)) throw new Error(`Not enough resources. Need ${fmtRes(cost)}.`);
  pay(v, cost);
  const time = u.time * count;
  v.train_queue.push({ unit, count, start: now(), end: now() + time });
  db.saveVillage(v);
  return { ok: true, time };
}

function actionCancelTrain(playerId, villageId) {
  const v = getOwnVillage(playerId, villageId);
  const job = v.train_queue[0];
  if (!job) throw new Error('Nothing is being trained.');
  const cost = unitCost(job.unit, job.count);
  v.res.wood += cost.wood; v.res.clay += cost.clay; v.res.iron += cost.iron;
  v.train_queue = [];
  db.saveVillage(v);
  return { ok: true };
}

// Sends troops. Also used by the AI. Returns the created movement or throws.
function actionSend(playerId, fromId, toId, kind, units) {
  const from = getOwnVillage(playerId, fromId);
  const to = db.getVillage(toId);
  if (!to) throw new Error('Target village does not exist.');
  if (to.id === from.id) throw new Error('You cannot attack your own village.');
  if ((from.buildings.rally || 0) < 1) throw new Error('Requires a Rally Point.');
  if (!['attack', 'raid', 'scout'].includes(kind)) throw new Error('Unknown mission type.');

  const avail = availableTroops(from);
  const send = {};
  let total = 0;
  for (const [u, n] of Object.entries(units || {})) {
    const cnt = Math.floor(Number(n) || 0);
    if (cnt <= 0) continue;
    if (kind === 'scout' && u !== 'scout') continue;
    if (kind === 'raid' && u === 'noble') continue; // noblemen cannot raid
    const take = Math.min(cnt, avail[u] || 0);
    if (take > 0) { send[u] = take; total += take; }
  }
  if (total === 0) throw new Error('No troops available for this mission.');
  if (kind === 'scout' && !send.scout) throw new Error('Send scouts.');

  for (const [u, n] of Object.entries(send)) {
    from.troops[u] -= n;
    if (from.troops[u] <= 0) delete from.troops[u];
  }
  const speed = Math.min(...Object.keys(send).map((u) => C.UNITS[u].speed));
  const dist = distanceOf(from, to);
  const hours = dist / speed;
  const arrive = now() + hours * HOUR;
  db.addMovement(playerId, from.id, to.id, kind, send, now(), arrive, null, null);
  db.saveVillage(from);

  // warn the defender
  if (to.owner_id !== null) {
    const ownerName = db.getPlayer(playerId)?.name || '?';
    db.addReport(
      to.owner_id, 'incoming', `Incoming ${kind} from ${ownerName}`,
      `${from.name} (${from.x}|${from.y}) is sending a ${kind} at ${to.name} (${to.x}|${to.y}). Arrival in about ${fmtDur(hours * HOUR)}.`,
      { attacker_id: playerId, defender_id: to.owner_id, from_id: from.id, to_id: to.id }
    );
  }
  return { ok: true, arrive, hours, dist };
}

// ============================================================
// movement arrivals
// ============================================================
function processArrival(mv, gameTime) {
  const from = db.getVillage(mv.from_id);
  const to = db.getVillage(mv.to_id);
  const units = db.parse(mv.units) || {};

  // troops returning home
  if (mv.kind === 'return') {
    if (from && from.owner_id === mv.player_id) {
      const v = from;
      for (const [u, n] of Object.entries(units)) v.troops[u] = (v.troops[u] || 0) + n;
      const loot = db.parse(mv.loot);
      if (loot) {
        const cap = warehouseCap(v);
        // add loot, but never reduce stock already above the cap (cheats/refunds)
        v.res.wood = v.res.wood > cap ? v.res.wood + (loot.wood || 0) : Math.min(cap, v.res.wood + (loot.wood || 0));
        v.res.clay = v.res.clay > cap ? v.res.clay + (loot.clay || 0) : Math.min(cap, v.res.clay + (loot.clay || 0));
        v.res.iron = v.res.iron > cap ? v.res.iron + (loot.iron || 0) : Math.min(cap, v.res.iron + (loot.iron || 0));
        db.addReport(mv.player_id, 'info', 'Troops returned with loot',
          `${fmtUnits(units)} returned home with ${fmtRes(loot)}.`, null);
      }
      db.saveVillage(v);
    }
    db.deleteMovement(mv.id);
    return;
  }

  if (!to) { // target village vanished (should not happen)
    returnHome(mv, from, units, null);
    return;
  }

  const attacker = db.getPlayer(mv.player_id);
  const attackerName = attacker ? attacker.name : '?';

  // ---- scout mission -----------------------------------------
  if (mv.kind === 'scout') {
    const defenders = to;
    const defScouts = defenders.troops.scout || 0;
    const survival = defScouts > 0 ? C.SCOUT_SURVIVAL_VS_SCOUTS : C.SCOUT_SURVIVAL;
    const scouts = units.scout || 0;
    const survivors = Math.random() < survival ? scouts : 0;
    const scoutInfo = { playerId: mv.player_id, troops: { ...defenders.troops }, at: gameTime };
    const sd = defenders.scout_data;
    sd[mv.player_id] = scoutInfo;
    defenders.scout_data = sd;
    db.saveVillage(defenders);

    if (survivors > 0) {
      db.addReport(mv.player_id, 'scout', 'Scouting report',
        `Your scouts observed ${to.name} (${to.x}|${to.y}):\n${fmtUnits(defenders.troops)}\n(Village owner: ${ownerLabel(to)}. Scouted ${fmtAgo(gameTime, gameTime)}.)`,
        { attacker_id: mv.player_id, defender_id: to.owner_id, from_id: mv.from_id, to_id: to.id });
    } else {
      db.addReport(mv.player_id, 'scout', 'Scouts were killed',
        `Your scouts were spotted and killed while observing ${to.name} (${to.x}|${to.y}).`,
        { attacker_id: mv.player_id, defender_id: to.owner_id, from_id: mv.from_id, to_id: to.id });
    }
    if (survivors > 0) returnHome(mv, from, { scout: survivors }, null);
    else db.deleteMovement(mv.id);
    return;
  }

  // ---- attack / raid -----------------------------------------
  const defenders = to;
  const defUnits = { ...defenders.troops };
  const wallLevel = defenders.buildings.wall || 0;

  // raids retreat without fighting if the defense is too strong
  if (mv.kind === 'raid') {
    const atkOff = combat.attackStrength(units);
    const defValue = combat.defenseStrength(defUnits, units, wallLevel);
    if (atkOff === 0 || defValue >= atkOff * C.RAID_RETREAT_RATIO) {
      db.addReport(mv.player_id, 'battle', 'Raid retreated',
        `Your raid on ${to.name} (${to.x}|${to.y}) turned back — the defenders were too strong. No losses.`,
        { attacker_id: mv.player_id, defender_id: to.owner_id, from_id: mv.from_id, to_id: to.id });
      returnHome(mv, from, units, null);
      return;
    }
  }

  const result = combat.resolveBattle(units, defUnits, wallLevel);
  const lines = [];
  lines.push(`Battle at ${to.name} (${to.x}|${to.y}).`);
  lines.push(`Attackers: ${fmtUnits(units)} (offense ${Math.round(result.atkOff)}).`);
  lines.push(`Defenders: ${fmtUnits(defUnits)} (defense ${Math.round(result.defValue)}${wallLevel ? `, wall level ${wallLevel}` : ''}).`);

  let loot = null;
  if (result.won) {
    lines.push(result.atkSurvivors && Object.keys(result.atkSurvivors).length
      ? `Victory! Losses: ${fmtUnits(result.atkLosses)}.`
      : 'Victory! Your army fell to the last man.');
    defenders.troops = {};
    db.saveVillage(defenders);

    // loot
    loot = combat.calcLoot(result.atkSurvivors, defenders.res);
    const totalLoot = loot.wood + loot.clay + loot.iron;
    if (totalLoot > 0) {
      defenders.res.wood -= loot.wood;
      defenders.res.clay -= loot.clay;
      defenders.res.iron -= loot.iron;
      lines.push(`Looted ${fmtRes(loot)}.`);
    } else {
      lines.push('The village had nothing worth looting.');
    }

    // rams knock down the wall
    const rams = result.atkSurvivors.ram || 0;
    let wallDropped = 0;
    for (let i = 0; i < rams; i++) if (Math.random() < C.RAM_WALL_DAMAGE) wallDropped++;
    if (wallDropped > 0 && (defenders.buildings.wall || 0) > 0) {
      const oldWall = defenders.buildings.wall;
      defenders.buildings.wall = Math.max(0, oldWall - wallDropped);
      lines.push(`Your rams knocked the wall down from level ${oldWall} to ${defenders.buildings.wall}.`);
    }

    // noblemen lower loyalty
    const nobles = result.atkSurvivors.noble || 0;
    if (nobles > 0) {
      let drop = 0;
      for (let i = 0; i < nobles; i++) drop += C.NOBLE_LOYALTY_MIN + Math.floor(Math.random() * (C.NOBLE_LOYALTY_MAX - C.NOBLE_LOYALTY_MIN + 1));
      const oldLoyalty = Math.round(defenders.loyalty);
      defenders.loyalty -= drop;
      lines.push(`Loyalty: ${oldLoyalty} → ${Math.round(defenders.loyalty)} (${nobles} noblemen).`);

      if (defenders.loyalty < 0) {
        conquerVillage(defenders, mv.player_id, lines, attackerName);
      }
    }
    db.saveVillage(defenders);
  } else {
    lines.push(`Defeat! The defenders held. Your losses: ${fmtUnits(result.atkLosses)}.`);
    defenders.troops = { ...result.defSurvivors };
    db.saveVillage(defenders);
  }

  const defenderReportTarget = to.owner_id;
  db.addReport(mv.player_id, 'battle', `${result.won ? 'Victory' : 'Defeat'} at ${to.name}`,
    lines.join('\n'),
    { attacker_id: mv.player_id, defender_id: defenderReportTarget, from_id: mv.from_id, to_id: to.id });
  if (defenderReportTarget !== null && defenderReportTarget !== mv.player_id) {
    db.addReport(defenderReportTarget, 'battle', `${attackerName} ${result.won ? 'attacked' : 'failed to attack'} ${to.name}`,
      `${attackerName}'s ${mv.kind} from ${from ? `${from.name} (${from.x}|${from.y})` : 'a village'} hit ${to.name} (${to.x}|${to.y}).\nDefender report:\n${lines.join('\n')}`,
      { attacker_id: mv.player_id, defender_id: defenderReportTarget, from_id: mv.from_id, to_id: to.id });
  }

  if (result.won && Object.keys(result.atkSurvivors).length > 0) {
    returnHome(mv, from, result.atkSurvivors, loot);
  } else {
    db.deleteMovement(mv.id);
  }
}

function conquerVillage(v, newOwnerId, lines, attackerName) {
  const oldOwner = v.owner_id;
  const oldName = ownerLabel(v);
  v.owner_id = newOwnerId;
  v.loyalty = 25;
  v.troops = {};
  v.build_queue = [];
  v.train_queue = [];
  v.scout_data = {};
  v.name = v.name.replace(/\s*\(conquered\)$/, '') + ' (conquered)';
  lines.push(`The village has been conquered! Loyalty reset to 25.`);

  db.addReport(newOwnerId, 'conquest', `You conquered ${v.name}`,
    `${attackerName} conquered ${oldName} (${v.x}|${v.y}). The village now belongs to you.\nBuildings are intact, but loyalty is low — defend it!`,
    { attacker_id: newOwnerId, defender_id: oldOwner, from_id: null, to_id: v.id });
  if (oldOwner !== null && oldOwner !== newOwnerId) {
    db.addReport(oldOwner, 'conquest', `${v.name} was conquered!`,
      `${attackerName} captured ${v.name} (${v.x}|${v.y}) from you.`,
      { attacker_id: newOwnerId, defender_id: oldOwner, from_id: null, to_id: v.id });
  }

  // defeat check for the human player
  const human = db.players().find((p) => p.is_human);
  if (human) {
    const stillAlive = db.villages().some((x) => x.owner_id === human.id);
    if (!stillAlive) db.setSetting('defeated', true);
  }
}

function returnHome(mv, from, units, loot) {
  if (!from || Object.keys(units).length === 0) { db.deleteMovement(mv.id); return; }
  const speed = Math.min(...Object.keys(units).map((u) => C.UNITS[u].speed));
  const to = db.getVillage(mv.to_id);
  const d = from && to ? distanceOf(from, to) : 1;
  db.addMovement(mv.player_id, mv.from_id, mv.from_id, 'return', units, now(), now() + (d / speed) * HOUR, loot, null);
  db.deleteMovement(mv.id);
}

function ownerLabel(v) {
  if (v.owner_id === null) return 'Barbarians';
  const p = db.getPlayer(v.owner_id);
  return p ? p.name : '?';
}

function describeReqs(reqs) {
  const parts = [];
  for (const [b, lvl] of Object.entries(reqs || {})) parts.push(`${C.BUILDINGS[b].name} level ${lvl}`);
  return parts.join(', ') || 'nothing';
}

// ============================================================
// barbarian growth & AI
// ============================================================
function barbGrow(world) {
  const diff = C.DIFFICULTY[world.difficulty] || C.DIFFICULTY.normal;
  const ageDays = world.game_time / C.GAME_DAY;
  for (const v of db.villages()) {
    if (v.owner_id !== null) continue;
    let changed = false;
    // random building upgrade
    if (Math.random() < 0.7) {
      const types = ['wood', 'clay', 'iron', 'farm', 'warehouse', 'wall', 'barracks', 'hq'];
      const type = types[Math.floor(Math.random() * types.length)];
      const lvl = v.buildings[type] || 0;
      const cap = Math.min(C.BUILDINGS[type].max, Math.round(3 + ageDays * 0.6));
      if (lvl < cap) { v.buildings[type] = lvl + 1; changed = true; }
    }
    // defenders grow over time
    const troopCap = Math.round((120 + ageDays * 10) * diff.barbGrowth);
    const total = Object.values(v.troops).reduce((a, b) => a + b, 0);
    if (total < troopCap) {
      const add = {
        spear: 10 + Math.floor(Math.random() * 20),
        sword: 5 + Math.floor(Math.random() * 12),
        archer: 5 + Math.floor(Math.random() * 12),
        axe: Math.floor(Math.random() * 8),
      };
      for (const [u, n] of Object.entries(add)) {
        if (total >= troopCap) break;
        const take = Math.min(n, troopCap - total);
        v.troops[u] = (v.troops[u] || 0) + take;
        changed = true;
      }
    }
    if (changed) db.saveVillage(v);
  }
}

function aiTick(world) {
  const ctx = {
    game_time: world.game_time,
    sendArmy: actionSend,
    buildingCost, buildingTime, canAfford, pay, unitCost, reqsMet,
    distanceOf, fmtUnits, availableTroops, productionRates, wheatUpkeep, warehouseCap,
  };
  for (const p of db.players()) {
    if (p.is_human) continue;
    aiDecide(p, ctx);
  }
}

// ============================================================
// main tick
// ============================================================
let tickCount = 0;
function tick(realDt) {
  const speed = db.getSetting('speed', 1);
  if (!speed || speed <= 0) return;
  if (db.villages().length === 0) return;

  const world = {
    game_time: db.getSetting('game_time', 0) + realDt * speed,
    difficulty: db.getSetting('difficulty', 'normal'),
  };
  db.setSetting('game_time', world.game_time);

  for (const v of db.villages()) updateVillage(v, realDt * speed, world.game_time);

  let arrivalHappened = false;
  for (const mv of [...db.movements()]) {
    if (mv.arrive <= world.game_time) { processArrival(mv, world.game_time); arrivalHappened = true; }
  }

  // loyalty regenerates (barbarian villages included)
  for (const v of db.villages()) {
    if (v.loyalty < 100) {
      v.loyalty = Math.min(100, v.loyalty + (C.LOYALTY_REGEN * realDt * speed) / HOUR);
      db.saveVillage(v);
    }
  }

  const lastGrowth = db.getSetting('last_barb_growth', 0);
  if (world.game_time - lastGrowth >= C.GAME_DAY) {
    db.setSetting('last_barb_growth', world.game_time);
    barbGrow(world);
  }

  aiTick(world);

  // persist: immediately after battles/arrivals, otherwise in batches
  if (arrivalHappened || ++tickCount % 5 === 0) db.flushVillages();
}

// ============================================================
// access & payload builders (used by the HTTP layer)
// ============================================================
function getOwnVillage(playerId, villageId) {
  const v = db.getVillage(villageId);
  if (!v) throw new Error('Village does not exist.');
  if (v.owner_id !== playerId) throw new Error('This village is not yours.');
  return v;
}

function humanPlayer() {
  return db.players().find((p) => p.is_human);
}

function ownVillageSummary(v) {
  const avail = availableTroops(v);
  const outgoingSum = {};
  for (const mv of db.movements()) {
    if (mv.from_id !== v.id || mv.kind === 'return') continue;
    for (const [u, n] of Object.entries(db.parse(mv.units) || {})) outgoingSum[u] = (outgoingSum[u] || 0) + n;
  }
  return {
    id: v.id, name: v.name, x: v.x, y: v.y, points: pointsOf(v), loyalty: Math.round(v.loyalty),
    buildings: v.buildings, res: v.res, troops: v.troops, available: avail, outgoing: outgoingSum,
  };
}

function movementSummaries(v, playerId) {
  const outgoing = [];
  const incoming = [];
  for (const mv of db.movements()) {
    if (mv.kind === 'return') continue;
    const to = db.getVillage(mv.to_id);
    if (mv.from_id === v.id && mv.player_id === playerId) {
      outgoing.push({
        kind: mv.kind, to_name: to ? to.name : '?', to_x: to ? to.x : 0, to_y: to ? to.y : 0,
        units: db.parse(mv.units), arrive: mv.arrive,
      });
    }
    if (mv.to_id === v.id) {
      incoming.push({ kind: mv.kind, arrive: mv.arrive, from_x: mv.from_id ? (db.getVillage(mv.from_id) || {}).x : 0, from_y: mv.from_id ? (db.getVillage(mv.from_id) || {}).y : 0 });
    }
  }
  return { outgoing, incoming };
}

function getState() {
  const human = humanPlayer();
  const players = db.players().map((p) => ({ id: p.id, name: p.name, color: p.color, is_human: !!p.is_human, difficulty: p.difficulty }));
  const villages = db.villages().map((v) => {
    return { id: v.id, owner_id: v.owner_id, x: v.x, y: v.y, name: v.name, points: pointsOf(v), loyalty: Math.round(v.loyalty) };
  });
  const myVillages = human
    ? db.villages().filter((r) => r.owner_id === human.id).map((r) => ownVillageSummary(r))
    : [];
  return {
    game_time: db.getSetting('game_time', 0),
    speed: db.getSetting('speed', 1),
    difficulty: db.getSetting('difficulty', 'normal'),
    defeated: !!db.getSetting('defeated', false),
    players,
    villages,
    myVillages,
    unread: human ? db.unreadCount(human.id) : 0,
    cheats: process.env.TC_CHEATS === '1',
    constants: { UNITS: C.UNITS, BUILDINGS: C.BUILDINGS, SPEEDS: C.SPEEDS, DIFFICULTY: Object.fromEntries(Object.entries(C.DIFFICULTY).map(([k, d]) => [k, d.label])), MAP_SIZE: C.MAP_SIZE },
  };
}

function getVillageDetail(playerId, villageId) {
  const v = db.getVillage(villageId);
  if (!v) throw new Error('Village does not exist.');

  if (v.owner_id === playerId) {
    const rates = productionRates(v);
    const { outgoing, incoming } = movementSummaries(v, playerId);
    const buildable = [];
    for (const [type, b] of Object.entries(C.BUILDINGS)) {
      const level = v.buildings[type] || 0;
      if (level >= b.max) continue;
      buildable.push({
        type, level, max: b.max,
        cost: buildingCost(type, level),
        time: buildingTime(type, level, v.buildings.hq || 1),
        reqMet: reqsMet(v, b.req),
      });
    }
    const trainable = [];
    for (const u of C.UNIT_ORDER) {
      const unit = C.UNITS[u];
      trainable.push({
        unit: u,
        buildingLevel: v.buildings[unit.from] || 0,
        reqMet: reqsMet(v, unit.req),
        cost: unit.cost, time: unit.time,
      });
    }
    return {
      own: true,
      id: v.id, owner_id: v.owner_id, x: v.x, y: v.y, name: v.name,
      points: pointsOf(v), loyalty: Math.round(v.loyalty),
      buildings: v.buildings,
      res: { wood: Math.floor(v.res.wood), clay: Math.floor(v.res.clay), iron: Math.floor(v.res.iron), wheat: Math.floor(v.res.wheat) },
      rates: { ...rates, wheatNet: Math.round((rates.wheat - wheatUpkeep(v)) * 10) / 10 },
      caps: { store: warehouseCap(v) },
      build_queue: v.build_queue,
      train_queue: v.train_queue,
      troops: v.troops,
      available: availableTroops(v),
      outgoing, incoming,
      buildable, trainable,
    };
  }

  // enemy / barbarian village: only public info + our own scouting data
  const scout = (v.scout_data[playerId]) || null;
  return {
    own: false,
    id: v.id, owner_id: v.owner_id, x: v.x, y: v.y, name: v.name,
    points: pointsOf(v), loyalty: Math.round(v.loyalty),
    owner_name: ownerLabel(v),
    scout,
    game_time: db.getSetting('game_time', 0),
  };
}

module.exports = {
  tick,
  getState, getVillageDetail,
  actionBuild, actionCancelBuild, actionTrain, actionCancelTrain, actionSend,
  reportsFor: (playerId) => db.reportsFor(playerId),
  markReportsRead: (playerId) => db.markReportsRead(playerId),
  newWorld: (difficulty) => generateWorld(difficulty),
  setSpeed: (speed) => { db.setSetting('speed', speed); },
  cheat: (playerId, villageId, res) => {
    const v = getOwnVillage(playerId, villageId);
    for (const [k, val] of Object.entries(res || {})) {
      if (['wood', 'clay', 'iron', 'wheat'].includes(k) && Number.isFinite(val)) v.res[k] += val;
    }
    db.saveVillage(v);
    return { ok: true };
  },
};

// ---- formatting helpers (shared with the UI where needed) ----
function fmtDur(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

function fmtAgo(at, gameTime) {
  return fmtDur(Math.max(0, gameTime - at)) + ' ago';
}

module.exports.fmtDur = fmtDur;
