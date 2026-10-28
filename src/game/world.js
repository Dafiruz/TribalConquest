// World generation: creates a fresh world with a human player, AI players and barbarian villages.
const C = require('./constants');
const db = require('./db');

function rand(min, max) { return min + Math.random() * (max - min); }
function ri(min, max) { return Math.floor(rand(min, max + 1)); }

function distance(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function randomBarbarianBuildings() {
  const b = {
    hq: ri(1, 3), barracks: ri(1, 3), stable: ri(1, 2), workshop: ri(0, 1),
    farm: ri(1, 5), warehouse: ri(1, 5), wall: ri(0, 4), rally: 1,
    wood: ri(1, 5), clay: ri(1, 5), iron: ri(1, 5),
  };
  b.smithy = ri(0, 2);
  return b;
}

function randomBarbarianTroops() {
  const t = {};
  const rolls = [
    ['spear', 10, 30], ['sword', 5, 15], ['archer', 5, 20], ['axe', 0, 10],
  ];
  for (const [unit, lo, hi] of rolls) {
    const n = ri(lo, hi);
    if (n > 0) t[unit] = n;
  }
  return t;
}

function barbarianName() {
  const a = ['Grey', 'Broken', 'Silent', 'Dark', 'Lost', 'Old', 'Savage', 'Misty', 'Bone', 'Ashen'];
  const b = ['Rock', 'Hill', 'Marsh', 'Hollow', 'Pines', 'Ford', 'Den', 'Moor', 'Ridge', 'Well'];
  return `${a[ri(0, a.length - 1)]}${b[ri(0, b.length - 1)]} Village`;
}

// Replaces the entire world with a fresh one.
function generateWorld(difficulty) {
  const diff = C.DIFFICULTY[difficulty] ? difficulty : 'normal';

  db.db.exec('BEGIN');

  try {
    db.resetWorld();

    db.setSetting('game_time', 0);
    db.setSetting('speed', 1);
    db.setSetting('difficulty', diff);
    db.setSetting('last_barb_growth', 0);

    // place all villages
    const placed = [];
    const spot = (n, minDist) => {
      let x, y, ok;
      for (let tries = 0; tries < 500; tries++) {
        x = ri(2, C.MAP_SIZE - 3);
        y = ri(2, C.MAP_SIZE - 3);
        ok = true;
        for (const p of placed) {
          if (distance({ x, y }, p) < minDist) { ok = false; break; }
        }
        if (ok) break;
      }
      if (!ok) { x = ri(2, C.MAP_SIZE - 3); y = ri(2, C.MAP_SIZE - 3); }
      placed.push({ x, y });
      return { x, y };
    };

    // human player
    const humanId = db.addPlayer('You', C.HUMAN_COLOR, true, diff);
    const home = spot(1, 5);
    db.addVillage(humanId, home.x, home.y, 'Home Village', { ...C.START_BUILDINGS }, { ...C.START_RES });

    // AI players, spread across the map
    const aiStarts = [
      { x: 10, y: 10 }, { x: C.MAP_SIZE - 11, y: 10 }, { x: 10, y: C.MAP_SIZE - 11 },
    ];
    for (let i = 0; i < C.AI_COUNT; i++) {
      const name = ['Wolf Clan', 'Iron Legion', 'Hawk Tribe'][i];
      const id = db.addPlayer(name, C.AI_COLORS[i], false, diff);
      const s = aiStarts[i];
      // jitter the start position a little
      const p = { x: s.x + ri(-2, 2), y: s.y + ri(-2, 2) };
      placed.push(p);
      db.addVillage(id, p.x, p.y, `${name} Village`, { ...C.START_BUILDINGS }, {
        wood: C.START_RES.wood * 1.2, clay: C.START_RES.clay * 1.2, iron: C.START_RES.iron * 1.2, wheat: C.START_RES.wheat,
      });
    }

    // barbarian villages
    for (let i = 0; i < C.BARB_COUNT; i++) {
      const p = spot(1, C.MIN_VILLAGE_DISTANCE);
      const res = { wood: ri(300, 1500), clay: ri(300, 1500), iron: ri(300, 1500), wheat: ri(200, 800) };
      const id = db.addVillage(null, p.x, p.y, barbarianName(), randomBarbarianBuildings(), res);
      // give the village some starting defenders (rows from getVillage are
      // already parsed; saveVillage caches the row and flushes it later)
      const v = db.getVillage(id);
      v.troops = randomBarbarianTroops();
      db.saveVillage(v);
    }

    db.db.exec('COMMIT');
  } catch (e) {
    db.db.exec('ROLLBACK');
    throw e;
  }
  return db.getSetting('difficulty');
}

module.exports = { generateWorld, distance };
