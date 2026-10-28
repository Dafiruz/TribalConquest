// HTTP layer: serves the UI and exposes the game API.
const express = require('express');
const path = require('node:path');
const C = require('./game/constants');
const db = require('./game/db');
const engine = require('./game/engine');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function human() {
  return db.players().find((p) => p.is_human) || null;
}

function wrap(fn) {
  return (req, res) => {
    try {
      const out = fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) {
      res.status(400).json({ error: e.message || 'Something went wrong.' });
    }
  };
}

// ---- API ------------------------------------------------------
app.get('/api/state', wrap(() => engine.getState()));

app.get('/api/village/:id', wrap((req) => {
  const h = human();
  if (!h) throw new Error('No game running.');
  return engine.getVillageDetail(h.id, Number(req.params.id));
}));

app.post('/api/village/:id/build', wrap((req) => {
  const h = human();
  return engine.actionBuild(h.id, Number(req.params.id), req.body.type);
}));

app.post('/api/village/:id/cancel-build', wrap((req) => {
  const h = human();
  return engine.actionCancelBuild(h.id, Number(req.params.id));
}));

app.post('/api/village/:id/train', wrap((req) => {
  const h = human();
  return engine.actionTrain(h.id, Number(req.params.id), req.body.unit, Number(req.body.count));
}));

app.post('/api/village/:id/cancel-train', wrap((req) => {
  const h = human();
  return engine.actionCancelTrain(h.id, Number(req.params.id));
}));

app.post('/api/village/:id/send', wrap((req) => {
  const h = human();
  const { to_id, kind, units } = req.body;
  return engine.actionSend(h.id, Number(req.params.id), Number(to_id), kind, units);
}));

app.get('/api/reports', wrap(() => {
  const h = human();
  if (!h) return { reports: [], unread: 0 };
  return { reports: engine.reportsFor(h.id), unread: db.unreadCount(h.id) };
}));

app.post('/api/reports/read-all', wrap(() => {
  const h = human();
  if (h) engine.markReportsRead(h.id);
  return { ok: true };
}));

app.post('/api/settings', wrap((req) => {
  const speed = Number(req.body.speed);
  if (!C.SPEEDS.includes(speed)) throw new Error('Invalid speed.');
  engine.setSpeed(speed);
  return { ok: true, speed };
}));

app.post('/api/world/new', wrap((req) => {
  const difficulty = req.body.difficulty || 'normal';
  if (!C.DIFFICULTY[difficulty]) throw new Error('Invalid difficulty.');
  engine.newWorld(difficulty);
  return { ok: true };
}));

if (process.env.TC_CHEATS === '1') {
  app.post('/api/cheat', wrap((req) => {
    const h = human();
    if (!h) throw new Error('No game running.');
    return engine.cheat(h.id, Number(req.body.village_id), req.body);
  }));
}

// ---- game loop -------------------------------------------------
let lastTick = Date.now();
setInterval(() => {
  const t = Date.now();
  const realDt = Math.min(5, (t - lastTick) / 1000); // clamp so server stalls don't fast-forward the game
  lastTick = t;
  try {
    engine.tick(realDt);
  } catch (e) {
    console.error('tick error:', e);
  }
}, C.TICK_MS);

// ---- startup ---------------------------------------------------
if (db.villages().length === 0) {
  const difficulty = 'normal';
  engine.newWorld(difficulty);
  console.log(`No save found — generated a new world (difficulty: ${difficulty}).`);
}

const PORT = Number(process.env.PORT) || 3210;
app.listen(PORT, () => {
  console.log(`Tribal Conquest running at http://localhost:${PORT}`);
  console.log('Open that URL in your browser to play.');
});
