// ============================================================
// Tribal Conquest - game balance & configuration
// All gameplay numbers live here so they are easy to tweak.
// ============================================================

// ---- World -------------------------------------------------
const MAP_SIZE = 60;               // map is MAP_SIZE x MAP_SIZE tiles
const BARB_COUNT = 55;             // barbarian villages scattered on the map
const AI_COUNT = 3;                // AI opponents
const MIN_VILLAGE_DISTANCE = 4;    // min distance between any two villages

// ---- Time --------------------------------------------------
// game time is measured in "game seconds". 1 game hour = 3600 game seconds.
const GAME_HOUR = 3600;
const GAME_DAY = 24 * GAME_HOUR;

// ---- Buildings ---------------------------------------------
// cost/level formula: cost = base * factor ^ (currentLevel)
//   (currentLevel = level you are upgrading FROM; level 1 -> 2 pays base)
// build time formula:  time = base * timeFactor ^ currentLevel
const BUILDINGS = {
  hq:        { name: 'Headquarters', max: 20, cost: { wood: 90,  clay: 80,  iron: 70  }, factor: 1.20, time: 500,  timeFactor: 1.20, desc: 'Orders new buildings. Higher level builds faster.' },
  barracks:  { name: 'Barracks',      max: 25, cost: { wood: 200, clay: 170, iron: 90  }, factor: 1.26, time: 700,  timeFactor: 1.20, desc: 'Trains infantry.' },
  stable:    { name: 'Stable',        max: 20, cost: { wood: 270, clay: 240, iron: 260 }, factor: 1.26, time: 900,  timeFactor: 1.20, desc: 'Trains cavalry and scouts.' },
  workshop:  { name: 'Workshop',      max: 15, cost: { wood: 300, clay: 240, iron: 260 }, factor: 1.26, time: 900,  timeFactor: 1.20, desc: 'Builds siege weapons.' },
  academy:   { name: 'Academy',       max: 3,  cost: { wood: 3000, clay: 5000, iron: 2000 }, factor: 2.00, time: 21600, timeFactor: 2.00, req: { smithy: 5 }, desc: 'Trains noblemen, who can conquer villages.' },
  farm:      { name: 'Farm',          max: 30, cost: { wood: 45,  clay: 40,  iron: 30  }, factor: 1.20, time: 300,  timeFactor: 1.20, desc: 'Produces wheat to feed your troops.' },
  warehouse: { name: 'Warehouse',     max: 30, cost: { wood: 60,  clay: 50,  iron: 40  }, factor: 1.17, time: 300,  timeFactor: 1.20, desc: 'Raises your resource storage capacity.' },
  wall:      { name: 'Wall',          max: 20, cost: { wood: 50,  clay: 100, iron: 20  }, factor: 1.26, time: 700,  timeFactor: 1.20, desc: 'Gives the defender a combat bonus.' },
  rally:     { name: 'Rally Point',   max: 1,  cost: { wood: 100, clay: 100, iron: 100 }, factor: 1.00, time: 600,  timeFactor: 1.00, desc: 'Send your troops on missions from here.' },
  smithy:    { name: 'Smithy',        max: 20, cost: { wood: 220, clay: 180, iron: 400 }, factor: 1.26, time: 1000, timeFactor: 1.20, desc: 'Researches better equipment, unlocking units.' },
  wood:      { name: 'Timber Camp',   max: 30, cost: { wood: 50,  clay: 60,  iron: 40  }, factor: 1.26, time: 300,  timeFactor: 1.20, desc: 'Produces wood.' },
  clay:      { name: 'Clay Pit',      max: 30, cost: { wood: 80,  clay: 40,  iron: 50  }, factor: 1.26, time: 300,  timeFactor: 1.20, desc: 'Produces clay.' },
  iron:      { name: 'Iron Mine',     max: 30, cost: { wood: 100, clay: 80,  iron: 30  }, factor: 1.26, time: 300,  timeFactor: 1.20, desc: 'Produces iron.' },
};

// resource fields produce per hour: base * growth ^ (level-1)
const FIELD_PROD = { base: 25, growth: 1.16 };      // wood/clay/iron per hour
const FARM_PROD = { base: 60, growth: 1.17 };        // wheat per hour
const WAREHOUSE_CAP = { base: 800, growth: 1.20 };   // storage cap per resource

// ---- Units -------------------------------------------------
// speed: fields per hour. carry: loot capacity. upkeep: wheat per hour.
// req: building levels needed to train.
const UNITS = {
  spear:  { name: 'Spearman',      from: 'barracks', cost: { wood: 50,  clay: 30,  iron: 10  }, time: 600,  atk: 10,  defI: 15,  defC: 45,  speed: 18, carry: 25, upkeep: 1,   req: {} },
  sword:  { name: 'Swordsman',     from: 'barracks', cost: { wood: 30,  clay: 30,  iron: 70  }, time: 900,  atk: 25,  defI: 50,  defC: 15,  speed: 22, carry: 15, upkeep: 1,   req: { smithy: 1 } },
  axe:    { name: 'Axeman',        from: 'barracks', cost: { wood: 60,  clay: 30,  iron: 40  }, time: 800,  atk: 40,  defI: 10,  defC: 5,   speed: 18, carry: 10, upkeep: 1,   req: { smithy: 1 } },
  archer: { name: 'Archer',        from: 'barracks', cost: { wood: 100, clay: 30,  iron: 60  }, time: 1000, atk: 15,  defI: 50,  defC: 40,  speed: 18, carry: 10, upkeep: 1,   req: { smithy: 1 } },
  scout:  { name: 'Scout',         from: 'stable',   cost: { wood: 50,  clay: 50,  iron: 20  }, time: 600,  atk: 0,   defI: 2,   defC: 1,   speed: 9,  carry: 0,  upkeep: 2,   req: { stable: 1, smithy: 1 } },
  lcav:   { name: 'Light Cavalry', from: 'stable',   cost: { wood: 125, clay: 100, iron: 250 }, time: 1800, atk: 130, defI: 30,  defC: 40,  speed: 10, carry: 80, upkeep: 4,   req: { stable: 1, smithy: 1 } },
  ram:    { name: 'Ram',           from: 'workshop', cost: { wood: 300, clay: 200, iron: 200 }, time: 2400, atk: 2,   defI: 20,  defC: 50,  speed: 30, carry: 0,  upkeep: 5,   req: { workshop: 1, smithy: 1 } },
  noble:  { name: 'Nobleman',      from: 'academy',  cost: { wood: 3000, clay: 4000, iron: 3000 }, time: 10800, atk: 30, defI: 100, defC: 50, speed: 35, carry: 0, upkeep: 100, req: { academy: 1 } },
};

const UNIT_ORDER = ['spear', 'sword', 'axe', 'archer', 'scout', 'lcav', 'ram', 'noble'];

// ---- Combat -------------------------------------------------
const WALL_MULT = 1.03;            // defender multiplier per wall level
const LOOT_FACTOR = 1.0;           // loot = min(carry capacity, stored)
const NOBLE_LOYALTY_MIN = 20;      // loyalty lost per surviving nobleman
const NOBLE_LOYALTY_MAX = 35;
const LOYALTY_REGEN = 1;           // loyalty regenerated per hour (conquered villages)
const RAID_RETREAT_RATIO = 0.9;    // a raid retreats if defender strength >= 90% of attacker strength
const SCOUT_SURVIVAL = 0.85;       // scout survival chance (no defending scouts)
const SCOUT_SURVIVAL_VS_SCOUTS = 0.5; // scout survival chance when defender has scouts
const RAM_WALL_DAMAGE = 0.5;       // chance per surviving ram to knock down 1 wall level

// ---- Starting state ------------------------------------------
const START_RES = { wood: 800, clay: 800, iron: 700, wheat: 500 };
const START_BUILDINGS = { hq: 1, barracks: 1, stable: 1, workshop: 1, farm: 1, warehouse: 1, rally: 1, wood: 1, clay: 1, iron: 1 }; // wall/smithy/academy start unbuilt

// ---- AI -------------------------------------------------------
const DIFFICULTY = {
  easy: {
    label: 'Easy',
    econFactor: 0.7,    // building-level targets multiplier
    armyFactor: 0.5,    // garrison/offense size multiplier
    farmRange: 10,      // max distance (fields) AI sends farming raids
    expandRange: 20,
    attacksPlayer: false,
    attackDelayHours: Infinity, // game hours before AI may attack the player
    barbGrowth: 0.8,
  },
  normal: {
    label: 'Normal',
    econFactor: 1.0,
    armyFactor: 0.8,
    farmRange: 14,
    expandRange: 25,
    attacksPlayer: true,
    attackDelayHours: 96,
    barbGrowth: 1.0,
  },
  hard: {
    label: 'Hard',
    econFactor: 1.3,
    armyFactor: 1.2,
    farmRange: 20,
    expandRange: 30,
    attacksPlayer: true,
    attackDelayHours: 48,
    barbGrowth: 1.3,
  },
};

const AI_COLORS = ['#e74c3c', '#9b59b6', '#e67e22'];
const HUMAN_COLOR = '#3498db';
const BARB_COLOR = '#8d8d8d';

// ---- Server ---------------------------------------------------
const SPEEDS = [0, 1, 10, 100];
const TICK_MS = 200;

module.exports = {
  MAP_SIZE, BARB_COUNT, AI_COUNT, MIN_VILLAGE_DISTANCE,
  GAME_HOUR, GAME_DAY,
  BUILDINGS, FIELD_PROD, FARM_PROD, WAREHOUSE_CAP,
  UNITS, UNIT_ORDER,
  WALL_MULT, LOOT_FACTOR,
  NOBLE_LOYALTY_MIN, NOBLE_LOYALTY_MAX, LOYALTY_REGEN,
  RAID_RETREAT_RATIO, SCOUT_SURVIVAL, SCOUT_SURVIVAL_VS_SCOUTS, RAM_WALL_DAMAGE,
  START_RES, START_BUILDINGS,
  DIFFICULTY, AI_COLORS, HUMAN_COLOR, BARB_COLOR,
  SPEEDS, TICK_MS,
};
