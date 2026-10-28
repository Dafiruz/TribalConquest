// Battle resolution (simplified Tribal Wars-style model).
const C = require('./constants');

function unitTotal(units) {
  return Object.values(units).reduce((a, b) => a + b, 0);
}

// Attack strength of an army = sum of attack values.
function attackStrength(units) {
  let s = 0;
  for (const [u, n] of Object.entries(units)) {
    s += (C.UNITS[u].atk || 0) * n;
  }
  return s;
}

// Defense strength depends on the attacker's infantry/cavalry mix.
function defenseStrength(defUnits, atkUnits, wallLevel) {
  const infAtk = ['spear', 'sword', 'axe', 'archer', 'noble'].reduce(
    (a, u) => a + (atkUnits[u] || 0) * (C.UNITS[u].atk || 0), 0);
  const totalAtk = attackStrength(atkUnits);
  const infRatio = totalAtk > 0 ? infAtk / totalAtk : 0.5;

  let s = 0;
  for (const [u, n] of Object.entries(defUnits)) {
    const unit = C.UNITS[u];
    s += n * (unit.defI * infRatio + unit.defC * (1 - infRatio));
  }
  s *= Math.pow(C.WALL_MULT, wallLevel || 0);
  return s;
}

// Lose a fraction of each unit type; returns surviving units and losses.
function applyLosses(units, fraction) {
  const losses = {};
  const survivors = {};
  for (const [u, n] of Object.entries(units)) {
    const lost = Math.min(n, Math.round(n * fraction));
    losses[u] = lost;
    if (n - lost > 0) survivors[u] = n - lost;
  }
  return { losses, survivors };
}

// Determines battle outcome. Mutates atkUnits/defUnits into survivors.
function resolveBattle(atkUnits, defUnits, wallLevel, opts = {}) {
  const atkOff = attackStrength(atkUnits);
  const defValue = defenseStrength(defUnits, atkUnits, wallLevel);
  const result = { won: atkOff > defValue, atkOff, defValue };

  if (atkOff > defValue) {
    // attacker wins; defender is wiped out, attacker takes losses
    const fraction = Math.min(1, Math.pow(defValue / atkOff, 1.5));
    const { losses, survivors } = applyLosses(atkUnits, fraction);
    result.atkLosses = losses;
    result.atkSurvivors = survivors;
    result.defLosses = { ...defUnits };
    result.defSurvivors = {};
    // noblemen always survive a victorious attack (they ride in after the battle)
    if (atkUnits.noble) {
      delete result.atkLosses.noble;
      result.atkSurvivors.noble = atkUnits.noble;
    }
  } else {
    // defender wins; attacker wiped out, defender takes losses
    const fraction = Math.min(1, Math.pow(atkOff / Math.max(defValue, 1), 1.5));
    const { losses, survivors } = applyLosses(defUnits, fraction);
    result.defLosses = losses;
    result.defSurvivors = survivors;
    result.atkLosses = { ...atkUnits };
    result.atkSurvivors = {};
  }
  return result;
}

// Loot calculation: min of carry capacity and stored resources.
function calcLoot(survivors, stored) {
  let carry = 0;
  for (const [u, n] of Object.entries(survivors)) carry += (C.UNITS[u].carry || 0) * n;
  const avail = { wood: stored.wood || 0, clay: stored.clay || 0, iron: stored.iron || 0 };
  const totalAvail = avail.wood + avail.clay + avail.iron;
  const totalLoot = Math.min(totalAvail, carry * C.LOOT_FACTOR);
  const loot = {};
  if (totalAvail > 0) {
    loot.wood = Math.floor(totalLoot * (avail.wood / totalAvail));
    loot.clay = Math.floor(totalLoot * (avail.clay / totalAvail));
    loot.iron = totalLoot - loot.wood - loot.clay;
  }
  return loot;
}

module.exports = { unitTotal, attackStrength, defenseStrength, resolveBattle, calcLoot };
