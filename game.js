"use strict";

// ============================================================
// CONFIG
// ============================================================
const CANVAS_W  = 800;
const CANVAS_H  = 560;
const TILE      = 40;
const GRAVITY   = 0.55;
const JUMP_FORCE = -13;
const PLAYER_W  = 28;
const PLAYER_H  = 36;
const PLAYER_SPEED = 4.5;
const NUM_LEVELS   = 10;
const LEVEL_SEG_W  = 10000;          // 10 segments ≈ 100000 world units to final flag
const WORLD_W      = NUM_LEVELS * LEVEL_SEG_W;
const GROUND_Y  = CANVAS_H - TILE;   // y where ground platforms start
const MUSHROOM_W = 24;
const MUSHROOM_H = 24;
const FIREBALL_SPEED = 10;
const FIRE_COOLDOWN_FRAMES = 21; // ~0.35s at 60fps
const MUSHROOM_ALIVE_SEC = 5;
const FIRE_POWER_SEC = 5;
const RESPAWN_INVINCIBLE_MS = 3000;

// ============================================================
// SUPABASE  — anon key only used for READ (leaderboard)
// Score writes go through Edge Functions which hold the secret.
// ============================================================
const SUPABASE_URL      = "https://mepescolmfmvtgbmdakw.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1lcGVzY29sbWZtdnRnYm1kYWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzNjY3MzUsImV4cCI6MjA5MTk0MjczNX0.1euG10m5Eq2gmRdlLRegdukKGWlvFs46gb_aJ8G8M8g";
const EDGE_BASE         = `${SUPABASE_URL}/functions/v1`;

let sbClient = null;
try {
  if (SUPABASE_URL !== "YOUR_SUPABASE_URL" && typeof window.supabase !== "undefined") {
    sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
} catch (_) {}

// ============================================================
// CANVAS
// ============================================================
const canvas = document.getElementById("gameCanvas");
const ctx    = canvas.getContext("2d");

// ============================================================
// SEEDED PRNG  (xorshift32)
// *** This exact function is also in the Edge Functions. ***
// Both must stay in sync — same seed produces same level.
// ============================================================
function makeRNG(seed) {
  let s = (seed ^ 0xdeadbeef) >>> 0;
  if (s === 0) s = 1;
  return () => {
    s ^= (s << 13);  s = s >>> 0;
    s ^= (s >> 17);  s = s >>> 0;
    s ^= (s << 5);   s = s >>> 0;
    return s / 4294967296;
  };
}

// ============================================================
// LEVEL GENERATION
// Returns all entities AND coin/enemy counts so the game
// knows the true totals (server independently recomputes these).
// ============================================================
function generateLevel(seed) {
  const rng = makeRNG(seed);

  const out = {
    platforms : [],
    coins     : [],
    enemies   : [],
    pipes     : [],
    questionBlocks: [],
    mushrooms : [],
    coinCount : 0,
    enemyCount: 0,
    groundSet : new Set(),   // tile-aligned x positions that have solid ground
  };

  // --- GROUND ---
  for (let x = 0; x < WORLD_W; x += TILE) {
    const gapRoll = rng();                             // RNG #1 per tile
    if (x > 800 && gapRoll < 0.04 && x < WORLD_W - 600) {
      const sz = Math.floor(rng() * 2 + 1);           // RNG #2 (gap size)
      x += TILE * sz;
      continue;
    }
    out.groundSet.add(x);
    out.platforms.push({ x, y: GROUND_Y, w: TILE, h: TILE * 3, type: "ground" });
  }

  // --- ELEVATED PLATFORMS + their coins + enemies ---
  const numPlat = (25 + Math.floor(rng() * 20)) * 5;  // RNG: numPlat (×5 for 5× world)
  let px = 300;
  for (let i = 0; i < numPlat; i++) {
    px += 200 + Math.floor(rng() * 250);              // RNG: px advance
    if (px > WORLD_W - 600) break;

    const pwTiles = 2 + Math.floor(rng() * 4);        // RNG: width in tiles
    const pw = pwTiles * TILE;
    const pyIdx = Math.floor(rng() * 3);              // RNG: height index
    const py = [GROUND_Y - 80, GROUND_Y - 140, GROUND_Y - 200][pyIdx];

    out.platforms.push({ x: px, y: py, w: pw, h: TILE, type: "brick" });

    const nCoins = Math.floor(rng() * 3) + 1;         // RNG: coin count (1-3)
    for (let c = 0; c < nCoins; c++) {
      const cx = px + c * TILE + TILE / 2;
      if (cx < px + pw) {
        out.coins.push({ x: cx, y: py - 30, r: false });
        out.coinCount++;
      }
    }

    const eRoll = rng();                              // RNG: enemy on platform?
    if (eRoll > 0.5) {
      const dirRoll = rng();                          // RNG: direction
      out.enemies.push({
        x: px + TILE, y: py - TILE + 4,
        w: TILE - 6, h: TILE - 6,
        vx: 1.4 * (dirRoll > 0.5 ? 1 : -1),
        minX: px, maxX: px + pw,
        alive: true, squished: false, squishTimer: 0,
      });
      out.enemyCount++;
    }
  }

  // --- FLOATING COIN ROWS ---
  const nRows = (15 + Math.floor(rng() * 10)) * 5;    // RNG: row count (×5 for 5× world)
  for (let i = 0; i < nRows; i++) {
    const rx  = 400 + Math.floor(rng() * (WORLD_W - 800));  // RNG: x
    const ry  = GROUND_Y - 100 - Math.floor(rng() * 150);   // RNG: y
    const len = 3 + Math.floor(rng() * 5);                  // RNG: length
    for (let c = 0; c < len; c++) {
      out.coins.push({ x: rx + c * 36, y: ry, r: false });
      out.coinCount++;
    }
  }

  // --- GROUND ENEMIES ---
  // Build sorted list of solid ground tile x positions in the valid spawn range
  // so enemies never spawn over a gap.
  const spawnableTiles = [...out.groundSet]
    .filter(x => x >= 600 && x <= WORLD_W - TILE * 5)
    .sort((a, b) => a - b);

  const nGround = (10 + Math.floor(rng() * 8)) * 5;   // RNG: count (×5 for 5× world)
  for (let i = 0; i < nGround; i++) {
    const tileIdx = Math.floor(rng() * spawnableTiles.length); // RNG: x (same 1 call)
    const ex      = spawnableTiles[tileIdx] ?? 600;
    const dirRoll = rng();                                      // RNG: direction
    out.enemies.push({
      x: ex, y: GROUND_Y - TILE + 4,
      w: TILE - 6, h: TILE - 6,
      vx: 1.2 * (dirRoll > 0.5 ? 1 : -1),
      minX: 0, maxX: WORLD_W,
      alive: true, squished: false, squishTimer: 0,
      groundBound: true,
    });
    out.enemyCount++;
  }

  // --- PIPES ---
  const nPipes = (8 + Math.floor(rng() * 5)) * 5;     // RNG: pipe count (×5 for 5× world)
  for (let i = 0; i < nPipes; i++) {
    const pipex = 600  + Math.floor(rng() * (WORLD_W - 900));  // RNG: x
    const pipeh = TILE * 2 + Math.floor(rng() * TILE);          // RNG: height
    out.pipes.push({ x: pipex, y: GROUND_Y - pipeh, w: TILE * 2, h: pipeh + TILE * 3 });
  }

  // --- QUESTION BLOCKS (must consume RNG in same order on server) ---
  // Same 2 rng() calls per block as before; snap X so block sits over standable ground/pipe-free.
  const nQ = (8 + Math.floor(rng() * 5)) * 5;         // ×5 for 5× world
  for (let i = 0; i < nQ; i++) {
    const qxRaw = 400 + Math.floor(rng() * (WORLD_W - 800));
    const qy = GROUND_Y - 130 - Math.floor(rng() * 90);
    const q = pickQuestionBlockPlacement(qxRaw, qy, out);
    out.questionBlocks.push({
      x: q.x, y: q.y, w: TILE, h: TILE,
      emptied: false, bumpTimer: 0,
    });
  }

  ensurePassablePath(out);
  return out;
}

// ============================================================
// PATH SAFETY — post-processing, no RNG consumed.
// Guarantees the player can always progress forward by:
//   1. Bridging ground gaps wider than MAX_GAP_TILES with
//      stepping-stone platforms (no coins/enemies added, so the
//      server's max-score calculation is unaffected).
//   2. Removing pipes that float over a gap (no solid ground
//      beneath them) — they would trap the player mid-jump.
// ============================================================
function ensurePassablePath(out) {
  const MAX_GAP_TILES = 3; // 3 tiles = 120 px; safely jumpable with a running start

  // --- 1. Patch overlong ground gaps ---
  let x = 0;
  while (x < WORLD_W) {
    if (out.groundSet.has(x)) { x += TILE; continue; }

    // Measure this contiguous gap
    const gapStart = x;
    let gapLen = 0;
    while (x < WORLD_W && !out.groundSet.has(x)) { gapLen++; x += TILE; }
    // x now points to the first solid tile after the gap (or WORLD_W)

    if (gapLen > MAX_GAP_TILES) {
      // Insert stepping stones so no sub-gap exceeds MAX_GAP_TILES tiles.
      // Stones are placed at indices MAX_GAP_TILES, 2*(MAX_GAP_TILES+1)-1, …
      // i.e. every (MAX_GAP_TILES + 1) tiles from the gap start.
      for (let step = MAX_GAP_TILES; step < gapLen; step += MAX_GAP_TILES + 1) {
        const stoneX = gapStart + step * TILE;
        if (!out.groundSet.has(stoneX)) {
          out.groundSet.add(stoneX);
          out.platforms.push({ x: stoneX, y: GROUND_Y, w: TILE, h: TILE * 3, type: "ground" });
        }
      }
    }
  }

  // --- 2. Remove pipes that float over a gap ---
  // A pipe over a gap blocks the player mid-jump and makes the gap uncrossable.
  out.pipes = out.pipes.filter(pipe => {
    const lx = Math.floor(pipe.x / TILE) * TILE;
    const rx = Math.floor((pipe.x + pipe.w - 1) / TILE) * TILE;
    return out.groundSet.has(lx) && out.groundSet.has(rx);
  });
}

function questionBlockOverlapsPipe(qx, qy, pipes) {
  for (const pipe of pipes) {
    if (overlap(qx, qy, TILE, TILE, pipe.x, pipe.y, pipe.w, pipe.h)) return true;
  }
  return false;
}

function hasStandableSupportUnder(out, bx, bw, by) {
  const blockBottom = by + TILE;
  if (blockBottom > GROUND_Y - 16) return false;
  for (let tx = Math.floor(bx / TILE) * TILE; tx < bx + bw; tx += TILE) {
    if (out.groundSet.has(tx)) return true;
  }
  return false;
}

function pickQuestionBlockPlacement(qxRaw, qy, out) {
  const tiles = [...out.groundSet].filter(x => x >= 320 && x < WORLD_W - 200)
    .sort((a, b) => Math.abs(a - qxRaw) - Math.abs(b - qxRaw));
  const tryX = (qx) => {
    if (!hasStandableSupportUnder(out, qx, TILE, qy)) return null;
    if (questionBlockOverlapsPipe(qx, qy, out.pipes)) return null;
    return { x: qx, y: qy };
  };
  for (const t of tiles) {
    const ok = tryX(t);
    if (ok) return ok;
    const ok2 = tryX(t + TILE);
    if (ok2) return ok2;
  }
  for (let step = 0; step < 60; step++) {
    const qx = 320 + step * TILE;
    if (qx >= WORLD_W - 400) break;
    const ok = tryX(qx);
    if (ok) return ok;
  }
  for (const t of [...out.groundSet].sort((a, b) => a - b)) {
    if (t < 320 || t >= WORLD_W - 200) continue;
    const ok = tryX(t);
    if (ok) return ok;
  }
  for (const t of [...out.groundSet].sort((a, b) => a - b)) {
    if (t < 280 || t >= WORLD_W - 200) continue;
    if (!hasStandableSupportUnder(out, t, TILE, qy)) continue;
    if (questionBlockOverlapsPipe(t, qy, out.pipes)) continue;
    return { x: t, y: qy };
  }
  return { x: 400, y: qy };
}

// ============================================================
// GAME STATE
// ============================================================
const state = {
  phase         : "start",   // start | loading | playing | dead | gameover | win | submitting | done
  score         : 0,
  lives         : 3,
  coinsCollected: 0,
  enemiesDefeated: 0,
  won           : false,
  runStartMs    : 0,
  playTimeMs    : 0,
  sessionId     : null,
  sessionToken  : null,
  levelSeed     : null,
  playerName    : "",
  popups        : [],   // floating score text
  flagsPassed   : 0,    // checkpoints cleared (0..10); win at 10
};

let level   = null;
let player  = null;
let camX    = 0;
let coinSpin = 0;
let lastTs  = 0;
let fireballs = [];
let nameAskedThisPageLoad = false;

function createPlayer() {
  return {
    x: 80, y: GROUND_Y - PLAYER_H,
    vx: 0, vy: 0,
    w: PLAYER_W, h: PLAYER_H,
    onGround: false,
    alive: true,
    invincibleUntilMs: 0,
    facingRight: true,
    walkFrame: 0,
    walkTimer: 0,
    maxX: 80,
    firePower: false,
    firePowerTimer: 0,
    fireCooldown: 0,
  };
}

// ============================================================
// INPUT
// ============================================================
const keys = {};
const isMobile = window.matchMedia("(hover: none) and (pointer: coarse)").matches;

window.addEventListener("keydown", e => {
  keys[e.code] = true;
  if (["Space","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.code)) e.preventDefault();
  if (state.phase === "start" && (e.code === "Space" || e.code === "Enter")) startGame();
  if ((state.phase === "done" || state.phase === "gameover") && (e.code === "Enter" || e.code === "Space")) resetToStart();
});
window.addEventListener("keyup", e => { keys[e.code] = false; });

// Touch controls
function setupTouchControls() {
  const btnLeft  = document.getElementById("touch-left");
  const btnRight = document.getElementById("touch-right");
  const btnJump  = document.getElementById("touch-jump");
  const btnFire  = document.getElementById("touch-fire");

  function bindBtn(el, key) {
    el.addEventListener("touchstart", e => {
      e.preventDefault();
      keys[key] = true;
      el.classList.add("pressed");
    }, { passive: false });
    const release = e => { keys[key] = false; el.classList.remove("pressed"); };
    el.addEventListener("touchend",    release);
    el.addEventListener("touchcancel", release);
  }

  bindBtn(btnLeft,  "ArrowLeft");
  bindBtn(btnRight, "ArrowRight");
  bindBtn(btnJump,  "Space");
  if (btnFire) bindBtn(btnFire, "KeyA");
}

// Tap canvas to start / restart on touch devices
canvas.addEventListener("touchstart", e => {
  e.preventDefault();
  if (state.phase === "start") startGame();
  else if (state.phase === "done" || state.phase === "gameover") resetToStart();
}, { passive: false });

setupTouchControls();

// ============================================================
// COLLISION HELPERS
// ============================================================
function overlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function resolveVsBoxes(boxes) {
  for (const b of boxes) {
    if (!overlap(player.x, player.y, player.w, player.h, b.x, b.y, b.w, b.h)) continue;
    const oL = (player.x + player.w) - b.x;
    const oR = (b.x + b.w) - player.x;
    const oT = (player.y + player.h) - b.y;
    const oB = (b.y + b.h) - player.y;
    const min = Math.min(oL, oR, oT, oB);
    if      (min === oT && player.vy >= 0) { player.y = b.y - player.h; player.vy = 0; player.onGround = true; }
    else if (min === oB && player.vy < 0)  { player.y = b.y + b.h;      player.vy = 0; }
    else if (min === oL)                   { player.x = b.x - player.w; player.vx = 0; }
    else if (min === oR)                   { player.x = b.x + b.w;      player.vx = 0; }
  }
}

function resolveEntityVsBoxes(ent, boxes) {
  for (const b of boxes) {
    if (!overlap(ent.x, ent.y, ent.w, ent.h, b.x, b.y, b.w, b.h)) continue;
    const oL = (ent.x + ent.w) - b.x;
    const oR = (b.x + b.w) - ent.x;
    const oT = (ent.y + ent.h) - b.y;
    const oB = (b.y + b.h) - ent.y;
    const min = Math.min(oL, oR, oT, oB);
    if      (min === oT && ent.vy >= 0) { ent.y = b.y - ent.h; ent.vy = 0; ent.onGround = true; }
    else if (min === oB && ent.vy < 0)  { ent.y = b.y + b.h;   ent.vy = 0; }
    else if (min === oL)                { ent.x = b.x - ent.w; ent.vx = -Math.abs(ent.vx); }
    else if (min === oR)                { ent.x = b.x + b.w;   ent.vx = Math.abs(ent.vx); }
  }
}

function resolveQuestionBlocks() {
  for (const b of level.questionBlocks) {
    if (!overlap(player.x, player.y, player.w, player.h, b.x, b.y, b.w, b.h)) continue;
    const oL = (player.x + player.w) - b.x;
    const oR = (b.x + b.w) - player.x;
    const oT = (player.y + player.h) - b.y;
    const oB = (b.y + b.h) - player.y;
    const min = Math.min(oL, oR, oT, oB);
    if      (min === oT && player.vy >= 0) { player.y = b.y - player.h; player.vy = 0; player.onGround = true; }
    else if (min === oB && player.vy < 0)  {
      player.y = b.y + b.h; player.vy = 0;
      if (!b.emptied) {
        b.emptied = true;
        b.bumpTimer = 14;
        spawnMushroom(b);
      }
    }
    else if (min === oL) { player.x = b.x - player.w; player.vx = 0; }
    else if (min === oR) { player.x = b.x + b.w;      player.vx = 0; }
  }
}

function spawnMushroom(block) {
  level.mushrooms.push({
    x: block.x + block.w / 2 - MUSHROOM_W / 2,
    y: block.y + block.h / 2 - MUSHROOM_H / 2,
    vx: 2.2,
    vy: 0,
    w: MUSHROOM_W,
    h: MUSHROOM_H,
    emerge: 0,
    onGround: false,
    lifeSec: MUSHROOM_ALIVE_SEC,
  });
}

// ============================================================
// SCORE POPUP
// ============================================================
function addPopup(x, y, text) {
  state.popups.push({ x, y, text, life: 60 });
}

// ============================================================
// UPDATE
// ============================================================
function update(dt) {
  if (state.phase !== "playing") return;

  coinSpin += dt * 4;

  const spMult = getLevelSpeedMult();
  const gMult  = getGravityMult();

  // --- Player input: ← → move, Space / ↑ / W jump, A fireball ---
  if (keys["ArrowLeft"])    { player.vx = -PLAYER_SPEED * spMult; player.facingRight = false; }
  else if (keys["ArrowRight"]) { player.vx = PLAYER_SPEED * spMult;  player.facingRight = true;  }
  else player.vx *= 0.75;

  if ((keys["Space"] || keys["ArrowUp"] || keys["KeyW"]) && player.onGround) {
    player.vy = JUMP_FORCE;
    player.onGround = false;
  }

  if (player.fireCooldown > 0) player.fireCooldown--;
  if (player.firePower && player.fireCooldown <= 0 && keys["KeyA"]) {
    player.fireCooldown = FIRE_COOLDOWN_FRAMES;
    const dir = player.facingRight ? 1 : -1;
    fireballs.push({
      x: player.facingRight ? player.x + player.w - 4 : player.x - 6,
      y: player.y + 14,
      vx: dir * FIREBALL_SPEED * spMult,
      vy: 0,
      life: 96,
    });
  }

  // --- Physics ---
  player.vy += GRAVITY * gMult;
  if (player.vy >  18) player.vy =  18;
  player.x += player.vx;
  player.y += player.vy;
  if (player.x < 0) player.x = 0;
  if (player.x > WORLD_W - player.w) player.x = WORLD_W - player.w;

  // --- Fall death (pit ignores i-frames so you can still lose a life in a hole) ---
  if (player.y > CANVAS_H + 80) { damagePlayer(true); return; }

  // --- Platform + pipe + ? blocks ---
  player.onGround = false;
  resolveVsBoxes(level.platforms);
  resolveVsBoxes(level.pipes);
  resolveQuestionBlocks();
  for (const qb of level.questionBlocks) {
    if (qb.bumpTimer > 0) qb.bumpTimer--;
  }

  // --- Track furthest-right for respawn ---
  if (player.x > player.maxX) player.maxX = player.x;

  if (player.firePower && player.firePowerTimer > 0) {
    player.firePowerTimer -= dt;
    if (player.firePowerTimer <= 0) {
      player.firePower = false;
      fireballs = [];
    }
  }

  // --- Walk animation ---
  player.walkTimer += dt;
  const moving = Math.abs(player.vx) > 0.5;
  if (moving && player.onGround && player.walkTimer > 0.1) {
    player.walkFrame = (player.walkFrame + 1) % 4;
    player.walkTimer = 0;
  }
  if (!moving) player.walkFrame = 0;

  // --- Mushrooms (power-up) ---
  const solidForMush = [...level.platforms, ...level.questionBlocks, ...level.pipes];
  for (let i = level.mushrooms.length - 1; i >= 0; i--) {
    const m = level.mushrooms[i];
    m.lifeSec -= dt;
    if (m.lifeSec <= 0) {
      level.mushrooms.splice(i, 1);
      continue;
    }
    if (m.emerge < 36) {
      m.y -= 2;
      m.emerge++;
      continue;
    }
    m.vy += GRAVITY * gMult;
    m.x += m.vx;
    m.y += m.vy;
    m.onGround = false;
    resolveEntityVsBoxes(m, solidForMush);
    if (m.y > CANVAS_H + 80) {
      level.mushrooms.splice(i, 1);
      continue;
    }
    if (overlap(player.x, player.y, player.w, player.h, m.x, m.y, m.w, m.h)) {
      const firstFire = !player.firePower;
      player.firePower = true;
      player.firePowerTimer = FIRE_POWER_SEC;
      if (firstFire) addPopup(m.x - camX + m.w / 2, m.y - 8, "FIRE!");
      level.mushrooms.splice(i, 1);
    }
  }

  // --- Fireballs ---
  for (let i = fireballs.length - 1; i >= 0; i--) {
    const f = fireballs[i];
    f.x += f.vx;
    f.life--;
    if (f.life <= 0) {
      fireballs.splice(i, 1);
      continue;
    }
    let wall = false;
    for (const b of solidForMush) {
      if (overlap(f.x, f.y, 8, 8, b.x, b.y, b.w, b.h)) {
        wall = true;
        break;
      }
    }
    if (wall || f.x < -20 || f.x > WORLD_W) {
      fireballs.splice(i, 1);
      continue;
    }
    let hitEnemy = false;
    for (const e of level.enemies) {
      if (!e.alive || e.squished) continue;
      if (overlap(f.x, f.y, 8, 8, e.x, e.y, e.w, e.h)) {
        e.squished = true;
        e.squishTimer = 25;
        state.enemiesDefeated++;
        state.score += 200;
        addPopup(e.x - camX, e.y - 20, "+200");
        hitEnemy = true;
        break;
      }
    }
    if (hitEnemy) fireballs.splice(i, 1);
  }

  // --- Coins ---
  for (const c of level.coins) {
    if (c.r) continue;
    if (overlap(player.x, player.y, player.w, player.h, c.x - 10, c.y - 10, 20, 20)) {
      c.r = true;
      state.coinsCollected++;
      state.score += 100;
      addPopup(c.x - camX, c.y, "+100");
    }
  }

  // --- Enemies ---
  for (const e of level.enemies) {
    if (!e.alive) continue;
    if (e.squished) {
      if (--e.squishTimer <= 0) e.alive = false;
      continue;
    }

    // Prevent ground enemies from crossing rivers or passing pipes
    if (e.groundBound) {
      // Gap check: no ground tile ahead → turn around
      const frontX = e.vx > 0 ? e.x + e.w : e.x - 1;
      const tileX  = Math.floor(frontX / TILE) * TILE;
      if (!level.groundSet.has(tileX)) {
        e.vx = -e.vx;
      } else {
        // Pipe check: next step would collide with a pipe → turn around
        const nx = e.x + e.vx;
        for (const pipe of level.pipes) {
          if (!overlap(e.x, e.y, e.w, e.h, pipe.x, pipe.y, pipe.w, pipe.h) &&
               overlap(nx,  e.y, e.w, e.h, pipe.x, pipe.y, pipe.w, pipe.h)) {
            e.vx = -e.vx;
            break;
          }
        }
      }
    }

    e.x += e.vx * spMult;
    if (e.x <= e.minX)          { e.x = e.minX;          e.vx =  Math.abs(e.vx); }
    if (e.x + e.w >= e.maxX)    { e.x = e.maxX - e.w;    e.vx = -Math.abs(e.vx); }

    if (performance.now() < player.invincibleUntilMs) continue;
    if (!overlap(player.x, player.y, player.w, player.h, e.x, e.y, e.w, e.h)) continue;

    // Stomp check: player falling + player bottom near enemy top
    if (player.vy > 0 && (player.y + player.h) < e.y + 16) {
      e.squished    = true;
      e.squishTimer = 25;
      player.vy     = -9;
      state.enemiesDefeated++;
      state.score += 200;
      addPopup(e.x - camX, e.y - 20, "+200");
    } else {
      damagePlayer();
      return;
    }
  }

  // --- Flags: one per segment; 10th flag wins (~20k world) ---
  const nextFlagX = (state.flagsPassed + 1) * LEVEL_SEG_W - 320;
  if (player.x + player.w >= nextFlagX) {
    state.flagsPassed++;
    if (state.flagsPassed >= NUM_LEVELS) {
      winGame();
      return;
    }
    state.score += 500;
    addPopup(CANVAS_W / 2, 100, `LEVEL ${state.flagsPassed + 1}`);
  }

  // --- Camera ---
  camX = Math.max(0, Math.min(player.x - CANVAS_W / 3, WORLD_W - CANVAS_W));

  // --- Popups ---
  for (let i = state.popups.length - 1; i >= 0; i--) {
    state.popups[i].y  -= 0.8;
    state.popups[i].life--;
    if (state.popups[i].life <= 0) state.popups.splice(i, 1);
  }
}

function damagePlayer(pitFall = false) {
  if (!pitFall && performance.now() < player.invincibleUntilMs) return;
  state.lives--;
  if (state.lives <= 0) {
    state.playTimeMs = Date.now() - state.runStartMs;
    state.phase = "gameover";
    submitScore();
  } else {
    player.x         = Math.max(80, player.maxX - 200);
    player.y         = GROUND_Y - PLAYER_H;
    player.vx        = 0;
    player.vy        = 0;
    player.invincibleUntilMs = performance.now() + RESPAWN_INVINCIBLE_MS;
    player.firePower  = false;
    player.firePowerTimer = 0;
    fireballs         = [];
  }
}

function winGame() {
  state.won   = true;
  state.score += 1000 + 1500;
  const timeSecs  = (Date.now() - state.runStartMs) / 1000;
  const timeBonus = Math.max(0, Math.floor(2000 - timeSecs * 8));
  state.score     += timeBonus;
  state.playTimeMs = Date.now() - state.runStartMs;
  state.phase      = "win";
  submitScore();
}

// ============================================================
// DRAW HELPERS
// ============================================================
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);       ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);   ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);       ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);           ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function lerpColor(hexA, hexB, t) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const u = Math.max(0, Math.min(1, t));
  const r = Math.round(a.r + (b.r - a.r) * u);
  const g = Math.round(a.g + (b.g - a.g) * u);
  const bl = Math.round(a.b + (b.b - a.b) * u);
  return `rgb(${r},${g},${bl})`;
}

function getLevelSpeedMult() {
  return 1 + state.flagsPassed * 0.042;
}

function getGravityMult() {
  return 1 + state.flagsPassed * 0.016;
}

function getCreepFactor() {
  return Math.min(1, state.flagsPassed / Math.max(1, NUM_LEVELS - 1));
}

// 0 spring, 1 summer, 2 fall, 3 winter — advances as you cross the world
function getSeasonProgress() {
  if (!player) return { index: 0, blend: 0 };
  const t = Math.min(1, Math.max(0, player.x / WORLD_W));
  const seg = t * 4;
  const index = Math.min(3, Math.floor(seg));
  const blend = seg - index;
  return { index, blend, t };
}

const SEASON_SKY_TOP = ["#fce4ec", "#29b6f6", "#ffcc80", "#cfd8dc"];
const SEASON_SKY_MID = ["#f8bbd0", "#4fc3f7", "#ffa726", "#90a4ae"];
const SEASON_SKY_BOT = ["#90caf9", "#81d4fa", "#ffab91", "#eceff1"];
const SEASON_HILL  = ["#66bb6a", "#43a047", "#8d6e63", "#b0bec5"];

function drawSeasonalLayers(seasonIndex, blend) {
  const next = (seasonIndex + 1) % 4;
  const top = lerpColor(SEASON_SKY_TOP[seasonIndex], SEASON_SKY_TOP[next], blend);
  const mid = lerpColor(SEASON_SKY_MID[seasonIndex], SEASON_SKY_MID[next], blend);
  const bot = lerpColor(SEASON_SKY_BOT[seasonIndex], SEASON_SKY_BOT[next], blend);

  const g = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  g.addColorStop(0, top);
  g.addColorStop(0.45, mid);
  g.addColorStop(1, bot);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Summer sun (fade in from late spring; full in summer)
  if (seasonIndex === 1 || (seasonIndex === 0 && blend > 0.62)) {
    const sunA = seasonIndex === 1 ? 1 : (blend - 0.62) / 0.38;
    if (sunA > 0.04) {
      ctx.globalAlpha = Math.min(1, sunA);
      ctx.fillStyle = "#fff9c4";
      ctx.beginPath();
      ctx.arc(CANVAS_W - 90, 85, 38, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255, 253, 200, 0.35)";
      ctx.beginPath();
      ctx.arc(CANVAS_W - 90, 85, 52, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // Spring: cherry blossom branches + drifting petals
  if (seasonIndex === 0 || (seasonIndex === 3 && blend > 0.85)) {
    const petalAlpha = seasonIndex === 0 ? 1 : (1 - blend) * 6;
    ctx.globalAlpha = Math.min(1, petalAlpha);
    for (let i = 0; i < 6; i++) {
      const bx = ((i * 210 - camX * 0.35) % (CANVAS_W + 120)) - 40;
      const by = 40 + (i % 3) * 25;
      ctx.strokeStyle = "#5d4037";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(bx, by + 30);
      ctx.quadraticCurveTo(bx + 40, by, bx + 90, by + 15);
      ctx.stroke();
      for (let p = 0; p < 5; p++) {
        const px = bx + 15 + p * 14;
        const py = by + 8 + Math.sin(p) * 4;
        ctx.fillStyle = "#f8bbd0";
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#f48fb1";
        ctx.beginPath();
        ctx.arc(px + 3, py + 2, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (let i = 0; i < 35; i++) {
      const px = ((i * 67 + camX * 0.4 + coinSpin * 18) % (CANVAS_W + 80)) - 20;
      const py = 30 + ((i * 41 + coinSpin * 22 + camX * 0.15) % (CANVAS_H - 120));
      ctx.fillStyle = "rgba(244, 143, 177, 0.55)";
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(coinSpin * 0.3 + i * 0.2);
      ctx.beginPath();
      ctx.ellipse(0, 0, 4, 2.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // Fall: drifting leaves
  if (seasonIndex === 2 || (seasonIndex === 1 && blend > 0.75) || (seasonIndex === 2 && blend < 0.2)) {
    const leafA = seasonIndex === 2 ? 1 : 0.5;
    ctx.globalAlpha = leafA;
    for (let i = 0; i < 28; i++) {
      const px = ((i * 89 - camX * 0.5) % (CANVAS_W + 60)) - 30;
      const py = 40 + ((i * 73 + coinSpin * 28 + camX * 0.25) % (CANVAS_H - 100));
      const wobble = Math.sin(coinSpin + i) * 0.4;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(wobble + i * 0.7);
      ctx.fillStyle = i % 3 === 0 ? "#e65100" : (i % 3 === 1 ? "#f57c00" : "#ff8f00");
      ctx.fillRect(-5, -2, 10, 5);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // Winter: snow
  if (seasonIndex === 3 || (seasonIndex === 2 && blend > 0.75)) {
    const snowA = seasonIndex === 3 ? 1 : (blend - 0.75) / 0.25;
    ctx.globalAlpha = Math.min(1, snowA);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    for (let i = 0; i < 55; i++) {
      const px = ((i * 47 + camX * 0.65 + coinSpin * 35) % (CANVAS_W + 30)) - 10;
      const py = ((i * 61 + coinSpin * 52 + camX * 0.1) % (CANVAS_H + 40)) - 20;
      ctx.fillRect(px, py, 2.5, 2.5);
      ctx.fillRect(px + 1, py + 3, 1.5, 1.5);
    }
    ctx.globalAlpha = 1;
  }
}

function drawBackground() {
  const { index, blend } = getSeasonProgress();
  drawSeasonalLayers(index, blend);

  const next = (index + 1) % 4;
  const cloudHex = index === 3
    ? lerpColor("#e3eaf2", "#ffffff", blend)
    : next === 3
    ? lerpColor("#ffffff", "#e3eaf2", blend)
    : "#ffffff";

  // Parallax clouds
  ctx.fillStyle = cloudHex;
  const clouds = [[120,70,50],[290,50,40],[480,80,55],[650,45,42],[780,65,38]];
  for (const [bx, by, r] of clouds) {
    const cx = ((bx - camX * 0.25 % (CANVAS_W + 200) + CANVAS_W + 200) % (CANVAS_W + 200)) - 100;
    ctx.beginPath();
    ctx.arc(cx,      by,     r,      0, Math.PI * 2);
    ctx.arc(cx + r,  by - 12, r + 6, 0, Math.PI * 2);
    ctx.arc(cx + r * 2.2, by, r,    0, Math.PI * 2);
    ctx.fill();
  }

  // Parallax hills (seasonal greens / frost)
  const hillCol = lerpColor(SEASON_HILL[index], SEASON_HILL[next], blend);
  ctx.fillStyle = hillCol;
  for (let h = 0; h < 8; h++) {
    const hx = ((h * 700 - camX * 0.45 + 5600) % 5600) - 200;
    const hr  = 100 + (h % 3) * 35;
    ctx.beginPath();
    ctx.arc(hx, CANVAS_H - 30, hr, Math.PI, 0);
    ctx.fill();
  }

  const creep = player ? getCreepFactor() : 0;
  if (creep > 0.02) {
    ctx.save();
    ctx.globalAlpha = 0.1 + creep * 0.12;
    ctx.fillStyle = "#050510";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.globalAlpha = 0.15 * creep;
    ctx.fillStyle = "#200008";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H * 0.5);
    const fog = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
    fog.addColorStop(0, "rgba(0,0,0,0)");
    fog.addColorStop(0.55, `rgba(10,5,20,${0.15 * creep})`);
    fog.addColorStop(1, `rgba(0,0,0,${0.35 * creep})`);
    ctx.globalAlpha = 1;
    ctx.fillStyle = fog;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.globalAlpha = 0.04 * creep;
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.restore();
  }
}

function drawWater() {
  for (let x = 0; x < WORLD_W; x += TILE) {
    if (level.groundSet.has(x)) continue;
    const sx = x - camX;
    if (sx + TILE < 0 || sx > CANVAS_W) continue;

    // Deep water fill
    ctx.fillStyle = "#0d47a1";
    ctx.fillRect(sx, GROUND_Y, TILE, CANVAS_H - GROUND_Y);

    // Animated surface wave
    const wave = Math.sin(coinSpin * 2 + x * 0.08) * 3;
    ctx.fillStyle = "#1565c0";
    ctx.fillRect(sx, GROUND_Y + wave, TILE, 10);

    // Surface highlight
    ctx.fillStyle = "rgba(100,181,246,0.35)";
    ctx.fillRect(sx + 2, GROUND_Y + wave, TILE - 4, 3);
  }
}

function drawQuestionBlock(b) {
  const sx = b.x - camX;
  if (sx + b.w < 0 || sx > CANVAS_W) return;
  const bump = b.bumpTimer > 0 ? (b.bumpTimer / 14) * 7 : 0;
  const y = b.y - bump;
  if (!b.emptied) {
    ctx.fillStyle = "#f9a825";
    ctx.fillRect(sx + 1, y + 1, b.w - 2, b.h - 2);
    ctx.strokeStyle = "#b8860b";
    ctx.lineWidth = 2;
    ctx.strokeRect(sx + 0.5, y + 0.5, b.w - 1, b.h - 1);
    ctx.fillStyle = "#fff8e1";
    ctx.font = "bold 22px 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("?", sx + b.w / 2, y + b.h / 2 + 2);
  } else {
    ctx.fillStyle = "#8d4a2a";
    ctx.fillRect(sx, y, b.w, b.h);
    ctx.strokeStyle = "#4e2a18";
    ctx.lineWidth = 1;
    for (let bx = 0; bx < b.w; bx += 10) {
      ctx.beginPath();
      ctx.moveTo(sx + bx, y);
      ctx.lineTo(sx + bx, y + b.h);
      ctx.stroke();
    }
    for (let by = 0; by < b.h; by += 10) {
      ctx.beginPath();
      ctx.moveTo(sx, y + by);
      ctx.lineTo(sx + b.w, y + by);
      ctx.stroke();
    }
  }
}

function drawMushroom(m) {
  const sx = m.x - camX;
  if (sx + m.w < 0 || sx > CANVAS_W) return;
  const cy = m.y + m.h * 0.35;
  ctx.fillStyle = "#c62828";
  ctx.beginPath();
  ctx.arc(sx + m.w / 2, cy, m.w * 0.48, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(sx + m.w * 0.35, cy - 2, 3, 0, Math.PI * 2);
  ctx.arc(sx + m.w * 0.65, cy - 2, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#eceff1";
  ctx.fillRect(sx + m.w * 0.35, m.y + m.h * 0.45, m.w * 0.3, m.h * 0.55);
}

function drawFireball(f) {
  const sx = f.x - camX;
  if (sx < -20 || sx > CANVAS_W + 20) return;
  const pulse = 0.85 + Math.sin(coinSpin * 3) * 0.15;
  ctx.fillStyle = "#ff6f00";
  ctx.beginPath();
  ctx.arc(sx + 4, f.y + 4, 5 * pulse, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffeb3b";
  ctx.beginPath();
  ctx.arc(sx + 3, f.y + 3, 2.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawPlatform(p) {
  const sx = p.x - camX;
  if (sx + p.w < 0 || sx > CANVAS_W) return;
  if (p.type === "ground") {
    ctx.fillStyle = "#4caf50";
    ctx.fillRect(sx, p.y, p.w, 8);
    ctx.fillStyle = "#795548";
    ctx.fillRect(sx, p.y + 8, p.w, p.h - 8);
  } else {
    ctx.fillStyle = "#bf4e30";
    ctx.fillRect(sx, p.y, p.w, p.h);
    ctx.strokeStyle = "#8b2e10";
    ctx.lineWidth = 1;
    for (let bx = 0; bx <= p.w; bx += 20) {
      ctx.beginPath(); ctx.moveTo(sx + bx, p.y); ctx.lineTo(sx + bx, p.y + p.h); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(sx, p.y + p.h / 2); ctx.lineTo(sx + p.w, p.y + p.h / 2); ctx.stroke();
  }
}

function drawPipe(pipe) {
  const sx = pipe.x - camX;
  if (sx + pipe.w < 0 || sx > CANVAS_W) return;
  ctx.fillStyle = "#2e7d32";
  ctx.fillRect(sx + 4, pipe.y + TILE, pipe.w - 8, pipe.h - TILE);
  ctx.fillStyle = "#388e3c";
  ctx.fillRect(sx, pipe.y, pipe.w, TILE);
  ctx.fillStyle = "#43a047";
  ctx.fillRect(sx + 4, pipe.y, 8, TILE);
  ctx.fillRect(sx + 4, pipe.y + TILE, 5, pipe.h - TILE);
}

function drawCoin(c) {
  if (c.r) return;
  const sx = c.x - camX;
  if (sx < -20 || sx > CANVAS_W + 20) return;
  const scale = Math.abs(Math.cos(coinSpin));
  ctx.save();
  ctx.translate(sx, c.y);
  ctx.scale(scale, 1);
  ctx.beginPath(); ctx.arc(0, 0, 10, 0, Math.PI * 2);
  ctx.fillStyle = "#ffd700"; ctx.fill();
  ctx.strokeStyle = "#e65100"; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = "#e65100"; ctx.font = "bold 9px Arial";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("$", 0, 1);
  ctx.restore();
}

function drawEnemy(e) {
  if (!e.alive) return;
  const sx = e.x - camX;
  if (sx + e.w < 0 || sx > CANVAS_W) return;
  const sqH = e.squished ? e.h * 0.3 : e.h;
  const sqY = e.squished ? e.y + e.h * 0.7 : e.y;
  ctx.fillStyle = "#6d4c41";
  roundRect(sx, sqY, e.w, sqH, 6);
  ctx.fill();
  if (!e.squished) {
    // Eyes
    ctx.fillStyle = "#fff";
    ctx.fillRect(sx + 5, e.y + 5, 9, 8);
    ctx.fillRect(sx + e.w - 14, e.y + 5, 9, 8);
    ctx.fillStyle = "#c62828";
    ctx.fillRect(sx + 7, e.y + 7, 5, 5);
    ctx.fillRect(sx + e.w - 12, e.y + 7, 5, 5);
    // Feet
    ctx.fillStyle = "#4e342e";
    ctx.fillRect(sx + 1, e.y + e.h - 7, 11, 7);
    ctx.fillRect(sx + e.w - 12, e.y + e.h - 7, 11, 7);
  }
}

function drawPlayer() {
  const sx = player.x - camX;
  if (performance.now() < player.invincibleUntilMs && Math.floor(performance.now() / 80) % 2 === 0) return;

  ctx.save();
  if (!player.facingRight) {
    ctx.translate(sx * 2 + player.w, 0);
    ctx.scale(-1, 1);
  }

  const ox = player.facingRight ? sx : sx;

  // Shoes
  ctx.fillStyle = "#3e2723";
  ctx.fillRect(ox + 1, player.y + player.h - 8, 10, 8);
  ctx.fillRect(ox + player.w - 11, player.y + player.h - 8, 10, 8);

  // Pants (blue overalls)
  ctx.fillStyle = "#1565c0";
  ctx.fillRect(ox + 3, player.y + player.h - 16, player.w - 6, 10);

  // Body (shirt — white when fire Mario)
  ctx.fillStyle = player.firePower ? "#fafafa" : "#c62828";
  ctx.fillRect(ox + 2, player.y + 14, player.w - 4, player.h - 30);

  // Arms
  ctx.fillStyle = player.firePower ? "#fafafa" : "#c62828";
  ctx.fillRect(ox - 4, player.y + 16, 7, 10);
  ctx.fillRect(ox + player.w - 3, player.y + 16, 7, 10);

  // Head
  ctx.fillStyle = "#ffcc80";
  ctx.fillRect(ox + 4, player.y + 2, player.w - 8, 14);

  // Hat (red; fire Mario keeps red cap)
  ctx.fillStyle = "#c62828";
  ctx.fillRect(ox + 2,  player.y - 2,  player.w - 4, 6);
  ctx.fillRect(ox + 6,  player.y - 8,  player.w - 12, 8);

  // Yale "Y" on cap (Yale blue outline, cream fill)
  ctx.font = "bold 8px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const capCx = ox + player.w / 2;
  const capCy = player.y - 4;
  ctx.strokeStyle = "#00356B";
  ctx.lineWidth = 1.25;
  ctx.fillStyle = "#fffef5";
  ctx.strokeText("Y", capCx, capCy);
  ctx.fillText("Y", capCx, capCy);

  // Eye
  ctx.fillStyle = "#000";
  ctx.fillRect(ox + player.w - 10, player.y + 6, 4, 4);

  // Mustache
  ctx.fillStyle = "#5d4037";
  ctx.fillRect(ox + player.w - 14, player.y + 12, 11, 3);

  ctx.restore();
}

function drawFlag() {
  for (let k = 0; k < NUM_LEVELS; k++) {
    const fx = (k + 1) * LEVEL_SEG_W - 320;
    const sx = fx - camX;
    if (sx + 60 < -40 || sx > CANVAS_W + 40) continue;
    const creep = k / Math.max(1, NUM_LEVELS - 1);
    const pole = lerpColor("#9e9e9e", "#3d3d45", creep);
    const flagR = lerpColor("#e63946", "#4a0a12", creep);
    const orb = lerpColor("#ffd700", "#5c4030", creep);
    ctx.fillStyle = pole;
    ctx.fillRect(sx, GROUND_Y - 180, 5, 180);
    ctx.fillStyle = flagR;
    ctx.beginPath();
    ctx.moveTo(sx + 5, GROUND_Y - 180);
    ctx.lineTo(sx + 50, GROUND_Y - 158);
    ctx.lineTo(sx + 5,  GROUND_Y - 136);
    ctx.fill();
    ctx.fillStyle = orb;
    ctx.beginPath();
    ctx.arc(sx + 2, GROUND_Y - 180, 7, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawHUD() {
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(0, 0, CANVAS_W, 52);

  ctx.fillStyle = "#fff";
  ctx.font = "bold 16px 'Courier New'";
  ctx.textAlign = "left";
  ctx.fillText(`SCORE ${String(state.score).padStart(6,"0")}`, 10, 22);

  ctx.textAlign = "center";
  ctx.fillText(`COINS ${String(state.coinsCollected).padStart(3,"0")}`, CANVAS_W / 2, 22);

  const seasonNames = ["Spring", "Summer", "Fall", "Winter"];
  const si = getSeasonProgress().index;
  ctx.fillStyle = "#b0bec5";
  ctx.font = "11px 'Courier New'";
  ctx.textAlign = "left";
  ctx.fillText(seasonNames[si], 10, 38);

  if (player && player.firePower) {
    ctx.fillStyle = "#ff6f00";
    ctx.font = "bold 14px 'Courier New'";
    ctx.textAlign = "center";
    ctx.fillText(`FIRE ${Math.max(0, Math.ceil(player.firePowerTimer))}s`, CANVAS_W / 2, 38);
  }

  ctx.fillStyle = "#9e9e9e";
  ctx.font = "9px 'Courier New'";
  ctx.textAlign = "center";
  ctx.fillText("[ \u2190 ] [ \u2192 ] move    [ Space ] jump    [ A ] fire", CANVAS_W / 2, 48);

  ctx.fillStyle = "#9ccc65";
  ctx.font = "bold 11px 'Courier New'";
  ctx.textAlign = "right";
  ctx.fillText(`STAGE ${state.flagsPassed + 1}/${NUM_LEVELS}`, CANVAS_W - 10, 40);

  ctx.fillStyle = "#e63946";
  ctx.font = "20px Arial";
  ctx.textAlign = "right";
  for (let i = 0; i < state.lives; i++) {
    ctx.fillText("♥", CANVAS_W - 10 - i * 22, 22);
  }
}

function drawPopups() {
  for (const p of state.popups) {
    const alpha = Math.min(1, p.life / 30);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "#ffd700";
    ctx.font = "bold 14px 'Courier New'";
    ctx.textAlign = "center";
    ctx.fillText(p.text, p.x, p.y);
  }
  ctx.globalAlpha = 1;
}

function drawOverlay(title, titleColor, lines, blink) {
  ctx.fillStyle = "rgba(0,0,0,0.78)";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.fillStyle = titleColor;
  ctx.font = "bold 50px 'Courier New'";
  ctx.textAlign = "center";
  ctx.fillText(title, CANVAS_W / 2, 190);

  ctx.font = "20px 'Courier New'";
  let y = 260;
  for (const line of lines) {
    ctx.fillStyle = line.color || "#fff";
    ctx.fillText(line.text, CANVAS_W / 2, y);
    y += 40;
  }

  if (blink) {
    ctx.fillStyle = Math.floor(Date.now() / 500) % 2 === 0 ? "#ffd700" : "#e6b800";
    ctx.font = "bold 20px 'Courier New'";
    ctx.fillText(isMobile ? "TAP TO PLAY AGAIN" : "PRESS ENTER or SPACE to play again", CANVAS_W / 2, CANVAS_H - 55);
  }
}

function drawStart() {
  drawBackground();
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.fillStyle = "#ffd700";
  ctx.font = "bold 54px 'Courier New'";
  ctx.textAlign = "center";
  ctx.fillText("MARIO RUNNER", CANVAS_W / 2, 170);

  ctx.fillStyle = "#e63946";
  ctx.font = "bold 18px 'Courier New'";
  ctx.fillText("SECURE LEADERBOARD EDITION", CANVAS_W / 2, 210);

  ctx.fillStyle = "#ccc";
  ctx.font = "16px 'Courier New'";
  ctx.fillText("Collect coins  +100    Stomp enemies  +200", CANVAS_W / 2, 280);
  ctx.fillText("10 stages · ~20k units · final flag wins  +2500", CANVAS_W / 2, 305);
  ctx.fillText("? blocks: bump from below  mushroom  A = fire", CANVAS_W / 2, 335);

  ctx.fillStyle = "#a5d6a7";
  ctx.font = "13px 'Courier New'";
  if (isMobile) {
    ctx.fillText("Touch:  [ \u25C0 ] [ \u25B6 ] move    [ Space ] jump    [ A ] fire", CANVAS_W / 2, 362);
    ctx.fillText("Fire needs ? mushroom", CANVAS_W / 2, 382);
  } else {
    ctx.fillText("[ \u2190 ] [ \u2192 ] move    [ Space ] jump    [ A ] fire", CANVAS_W / 2, 362);
    ctx.fillText("\u2191 and W also jump · fire after ? mushroom", CANVAS_W / 2, 382);
  }

  if (Math.floor(Date.now() / 600) % 2 === 0) {
    ctx.fillStyle = "#ffd700";
    ctx.font = "bold 22px 'Courier New'";
    ctx.fillText(isMobile ? "TAP TO START" : "PRESS SPACE TO START", CANVAS_W / 2, 420);
  }
}

function drawLoading() {
  ctx.fillStyle = "#0d0d1a";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.fillStyle = "#ffd700";
  ctx.font = "bold 22px 'Courier New'";
  ctx.textAlign = "center";
  const dots = ".".repeat((Math.floor(Date.now() / 400) % 4));
  ctx.fillText("Getting secure session" + dots, CANVAS_W / 2, CANVAS_H / 2);
}

// ============================================================
// RENDER
// ============================================================
function render() {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.textBaseline = "middle";

  if (state.phase === "loading") { drawLoading(); return; }
  if (state.phase === "start")   { drawStart();   return; }

  drawBackground();
  if (level) {
    drawWater();
    for (const p of level.platforms) drawPlatform(p);
    for (const b of level.questionBlocks) drawQuestionBlock(b);
    for (const p of level.pipes)     drawPipe(p);
    for (const c of level.coins)     drawCoin(c);
    for (const m of level.mushrooms) drawMushroom(m);
    for (const e of level.enemies)   drawEnemy(e);
    for (const f of fireballs)       drawFireball(f);
    drawFlag();
  }
  if (player) drawPlayer();
  drawHUD();
  drawPopups();

  const submitting = state.phase === "submitting";
  const done       = state.phase === "done";
  const statusText = submitting ? "Saving score..."
                   : (sbClient ? "Score saved!" : "");
  const statusColor = submitting ? "#ffd700" : "#4caf50";

  if (state.phase === "gameover" || (submitting && !state.won) || (done && !state.won)) {
    drawOverlay("GAME OVER", "#e63946", [
      { text: `Score: ${state.score}` },
      { text: `Coins: ${state.coinsCollected}   Enemies: ${state.enemiesDefeated}` },
      ...(statusText ? [{ text: statusText, color: statusColor }] : []),
    ], done);
  }

  if (state.phase === "win" || (submitting && state.won) || (done && state.won)) {
    drawOverlay("YOU WIN!", "#ffd700", [
      { text: "All 10 stages cleared!" },
      { text: `Final Score: ${state.score}` },
      { text: `Coins: ${state.coinsCollected}   Enemies: ${state.enemiesDefeated}` },
      ...(statusText ? [{ text: statusText, color: statusColor }] : []),
    ], done);
  }
}

// ============================================================
// GAME LOOP
// ============================================================
function gameLoop(ts) {
  const dt = Math.min((ts - lastTs) / 1000, 0.05);
  lastTs = ts;
  update(dt);
  render();
  requestAnimationFrame(gameLoop);
}

// ============================================================
// NETWORK — SECURE SCORE SUBMISSION
//
// SECURITY MODEL:
//   1. startSession() calls the "start-session" Edge Function.
//      The server generates a seed, computes the EXACT max score
//      achievable for that level, signs a token with HMAC-SHA256
//      using SESSION_SECRET (server-only env var), and stores it.
//
//   2. submitScore() sends score + sessionId + token to the
//      "submit-score" Edge Function. The server re-derives the
//      expected token from its DB record, compares via HMAC,
//      checks score <= max_score (server-computed), marks session
//      used (one-time), then inserts the score.
//
//   WHY IT'S SECURE:
//   - SESSION_SECRET never leaves the server — token cannot be forged
//   - max_score is computed server-side from the seed — cannot be inflated
//   - Session is one-time use — replaying the token does nothing
//   - Direct DB inserts are blocked by RLS (no anon insert on mario_scores)
// ============================================================
async function startSession() {
  if (SUPABASE_URL === "YOUR_SUPABASE_URL") return null;
  try {
    const res = await fetch(`${EDGE_BASE}/start-session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });
    if (!res.ok) throw new Error("session start failed");
    return await res.json();  // { sessionId, token, seed }
  } catch (e) {
    console.warn("startSession failed:", e.message);
    return null;
  }
}

async function submitScore() {
  state.phase = "submitting";

  if (state.sessionToken) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 8000);  // 8s timeout
      const res = await fetch(`${EDGE_BASE}/submit-score`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          sessionId      : state.sessionId,
          token          : state.sessionToken,
          name           : state.playerName || "Guest",
          score          : state.score,
          coinsCollected : state.coinsCollected,
          enemiesDefeated: state.enemiesDefeated,
          won            : state.won,
          playTimeMs     : state.playTimeMs,
        }),
      });
      clearTimeout(timeout);
      const result = await res.json();
      if (result.rank) console.log(`Leaderboard rank: #${result.rank}`);
    } catch (e) {
      console.warn("submitScore failed:", e.message);
    }
  }

  state.phase = "done";
  await loadLeaderboard();
}

async function loadLeaderboard() {
  const el = document.getElementById("leaderboardList");
  if (!sbClient) {
    if (el) el.innerHTML = "<li style='color:#555;font-size:10px'>Configure Supabase<br>to enable scores</li>";
    return;
  }
  try {
    const { data } = await sbClient
      .from("mario_scores")
      .select("name, score")
      .order("score", { ascending: false })
      .limit(10);
    if (data) renderLeaderboard(data);
  } catch (_) {
    if (el) el.innerHTML = "<li style='color:#555'>Unavailable</li>";
  }
}

function renderLeaderboard(items) {
  const el = document.getElementById("leaderboardList");
  if (!el) return;
  el.innerHTML = items.length
    ? items.map((r, i) => `<li>#${i + 1} ${r.name} &mdash; ${r.score}</li>`).join("")
    : "<li>No scores yet</li>";
}

// ============================================================
// GAME FLOW
// ============================================================
async function startGame() {
  // Ask for name once per page load (refresh asks again — no localStorage)
  if (!nameAskedThisPageLoad) {
    const n = window.prompt("Enter your name for the leaderboard (max 12 chars):", "") || "Guest";
    state.playerName = n.trim().slice(0, 12) || "Guest";
    nameAskedThisPageLoad = true;
  }

  state.phase = "loading";

  const session = await startSession();
  const seed = session ? session.seed : (Math.random() * 0xFFFFFFFF >>> 0);

  state.sessionId    = session ? session.sessionId : null;
  state.sessionToken = session ? session.token     : null;
  state.levelSeed    = seed;

  level  = generateLevel(seed);
  player = createPlayer();
  camX   = 0;
  coinSpin = 0;

  state.score          = 0;
  state.lives          = 3;
  state.coinsCollected = 0;
  state.enemiesDefeated = 0;
  state.won            = false;
  state.runStartMs     = Date.now();
  state.playTimeMs     = 0;
  state.popups         = [];
  state.flagsPassed    = 0;
  fireballs            = [];
  keys["Space"] = false;
  keys["KeyA"]  = false;
  state.phase          = "playing";
}

function resetToStart() {
  state.phase        = "start";
  state.sessionId    = null;
  state.sessionToken = null;
  keys["Space"] = false;
  keys["KeyA"]  = false;
}

// ============================================================
// INIT
// ============================================================
loadLeaderboard();
lastTs = performance.now();
requestAnimationFrame(gameLoop);
