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
const WORLD_W   = 8000;
const GROUND_Y  = CANVAS_H - TILE;   // y where ground platforms start

// ============================================================
// SUPABASE  — anon key only used for READ (leaderboard)
// Score writes go through Edge Functions which hold the secret.
// ============================================================
const SUPABASE_URL      = "YOUR_SUPABASE_URL";
const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY";
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
    flagX     : WORLD_W - 320,
    coinCount : 0,
    enemyCount: 0,
  };

  // --- GROUND ---
  for (let x = 0; x < WORLD_W; x += TILE) {
    const gapRoll = rng();                             // RNG #1 per tile
    if (x > 800 && gapRoll < 0.04 && x < WORLD_W - 600) {
      const sz = Math.floor(rng() * 2 + 1);           // RNG #2 (gap size)
      x += TILE * sz;
      continue;
    }
    out.platforms.push({ x, y: GROUND_Y, w: TILE, h: TILE * 3, type: "ground" });
  }

  // --- ELEVATED PLATFORMS + their coins + enemies ---
  const numPlat = 25 + Math.floor(rng() * 20);        // RNG: numPlat
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
  const nRows = 15 + Math.floor(rng() * 10);          // RNG: row count
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
  const nGround = 10 + Math.floor(rng() * 8);         // RNG: count
  for (let i = 0; i < nGround; i++) {
    const ex      = 600 + Math.floor(rng() * (WORLD_W - 900)); // RNG: x
    const dirRoll = rng();                                       // RNG: direction
    out.enemies.push({
      x: ex, y: GROUND_Y - TILE + 4,
      w: TILE - 6, h: TILE - 6,
      vx: 1.2 * (dirRoll > 0.5 ? 1 : -1),
      minX: 0, maxX: WORLD_W,
      alive: true, squished: false, squishTimer: 0,
    });
    out.enemyCount++;
  }

  // --- PIPES ---
  const nPipes = 8 + Math.floor(rng() * 5);           // RNG: pipe count
  for (let i = 0; i < nPipes; i++) {
    const pipex = 600  + Math.floor(rng() * (WORLD_W - 900));  // RNG: x
    const pipeh = TILE * 2 + Math.floor(rng() * TILE);          // RNG: height
    out.pipes.push({ x: pipex, y: GROUND_Y - pipeh, w: TILE * 2, h: pipeh + TILE * 3 });
  }

  return out;
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
  playerName    : localStorage.getItem("marioName") || "",
  popups        : [],   // floating score text
};

let level   = null;
let player  = null;
let camX    = 0;
let coinSpin = 0;
let lastTs  = 0;

function createPlayer() {
  return {
    x: 80, y: GROUND_Y - PLAYER_H,
    vx: 0, vy: 0,
    w: PLAYER_W, h: PLAYER_H,
    onGround: false,
    alive: true,
    invincible: 0,
    facingRight: true,
    walkFrame: 0,
    walkTimer: 0,
    maxX: 80,
  };
}

// ============================================================
// INPUT
// ============================================================
const keys = {};
window.addEventListener("keydown", e => {
  keys[e.code] = true;
  if (["Space","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.code)) e.preventDefault();
  if (state.phase === "start" && (e.code === "Space" || e.code === "Enter")) startGame();
  if (state.phase === "done"  && e.code === "Enter") resetToStart();
});
window.addEventListener("keyup", e => { keys[e.code] = false; });

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

  // --- Player input ---
  if (keys["ArrowLeft"] || keys["KeyA"])  { player.vx = -PLAYER_SPEED; player.facingRight = false; }
  else if (keys["ArrowRight"] || keys["KeyD"]) { player.vx = PLAYER_SPEED;  player.facingRight = true;  }
  else player.vx *= 0.75;

  if ((keys["Space"] || keys["ArrowUp"] || keys["KeyW"]) && player.onGround) {
    player.vy = JUMP_FORCE;
    player.onGround = false;
  }

  // --- Physics ---
  player.vy += GRAVITY;
  if (player.vy >  18) player.vy =  18;
  player.x += player.vx;
  player.y += player.vy;
  if (player.x < 0) player.x = 0;
  if (player.x > WORLD_W - player.w) player.x = WORLD_W - player.w;

  // --- Fall death ---
  if (player.y > CANVAS_H + 80) { damagePlayer(); return; }

  // --- Platform + pipe collision ---
  player.onGround = false;
  resolveVsBoxes(level.platforms);
  resolveVsBoxes(level.pipes);

  // --- Track furthest-right for respawn ---
  if (player.x > player.maxX) player.maxX = player.x;

  // --- Invincibility ---
  if (player.invincible > 0) player.invincible--;

  // --- Walk animation ---
  player.walkTimer += dt;
  const moving = Math.abs(player.vx) > 0.5;
  if (moving && player.onGround && player.walkTimer > 0.1) {
    player.walkFrame = (player.walkFrame + 1) % 4;
    player.walkTimer = 0;
  }
  if (!moving) player.walkFrame = 0;

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

    e.x += e.vx;
    if (e.x <= e.minX)          { e.x = e.minX;          e.vx =  Math.abs(e.vx); }
    if (e.x + e.w >= e.maxX)    { e.x = e.maxX - e.w;    e.vx = -Math.abs(e.vx); }

    if (player.invincible > 0) continue;
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

  // --- Flag (win) ---
  if (player.x + player.w >= level.flagX) {
    winGame();
    return;
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

function damagePlayer() {
  if (player.invincible > 0) return;
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
    player.invincible = 120;
  }
}

function winGame() {
  state.won   = true;
  state.score += 1000;
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

function drawBackground() {
  const g = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  g.addColorStop(0, "#4a8fd4");
  g.addColorStop(1, "#87bdea");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Parallax clouds
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  const clouds = [[120,70,50],[290,50,40],[480,80,55],[650,45,42],[780,65,38]];
  for (const [bx, by, r] of clouds) {
    const cx = ((bx - camX * 0.25 % (CANVAS_W + 200) + CANVAS_W + 200) % (CANVAS_W + 200)) - 100;
    ctx.beginPath();
    ctx.arc(cx,      by,     r,      0, Math.PI * 2);
    ctx.arc(cx + r,  by - 12, r + 6, 0, Math.PI * 2);
    ctx.arc(cx + r * 2.2, by, r,    0, Math.PI * 2);
    ctx.fill();
  }

  // Parallax hills
  ctx.fillStyle = "#388e3c";
  for (let h = 0; h < 8; h++) {
    const hx = ((h * 700 - camX * 0.45 + 5600) % 5600) - 200;
    const hr  = 100 + (h % 3) * 35;
    ctx.beginPath();
    ctx.arc(hx, CANVAS_H - 30, hr, Math.PI, 0);
    ctx.fill();
  }
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
  if (player.invincible > 0 && Math.floor(player.invincible / 6) % 2 === 0) return;

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

  // Body (red shirt)
  ctx.fillStyle = "#c62828";
  ctx.fillRect(ox + 2, player.y + 14, player.w - 4, player.h - 30);

  // Arms
  ctx.fillStyle = "#c62828";
  ctx.fillRect(ox - 4, player.y + 16, 7, 10);
  ctx.fillRect(ox + player.w - 3, player.y + 16, 7, 10);

  // Head
  ctx.fillStyle = "#ffcc80";
  ctx.fillRect(ox + 4, player.y + 2, player.w - 8, 14);

  // Hat
  ctx.fillStyle = "#c62828";
  ctx.fillRect(ox + 2,  player.y - 2,  player.w - 4, 6);
  ctx.fillRect(ox + 6,  player.y - 8,  player.w - 12, 8);

  // Eye
  ctx.fillStyle = "#000";
  ctx.fillRect(ox + player.w - 10, player.y + 6, 4, 4);

  // Mustache
  ctx.fillStyle = "#5d4037";
  ctx.fillRect(ox + player.w - 14, player.y + 12, 11, 3);

  ctx.restore();
}

function drawFlag() {
  const sx = level.flagX - camX;
  if (sx < -60 || sx > CANVAS_W + 60) return;
  ctx.fillStyle = "#9e9e9e";
  ctx.fillRect(sx, GROUND_Y - 180, 5, 180);
  ctx.fillStyle = "#e63946";
  ctx.beginPath();
  ctx.moveTo(sx + 5, GROUND_Y - 180);
  ctx.lineTo(sx + 50, GROUND_Y - 158);
  ctx.lineTo(sx + 5,  GROUND_Y - 136);
  ctx.fill();
  ctx.fillStyle = "#ffd700";
  ctx.beginPath();
  ctx.arc(sx + 2, GROUND_Y - 180, 7, 0, Math.PI * 2);
  ctx.fill();
}

function drawHUD() {
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(0, 0, CANVAS_W, 44);

  ctx.fillStyle = "#fff";
  ctx.font = "bold 16px 'Courier New'";
  ctx.textAlign = "left";
  ctx.fillText(`SCORE ${String(state.score).padStart(6,"0")}`, 10, 26);

  ctx.textAlign = "center";
  ctx.fillText(`COINS ${String(state.coinsCollected).padStart(3,"0")}`, CANVAS_W / 2, 26);

  ctx.textAlign = "right";
  for (let i = 0; i < state.lives; i++) {
    ctx.fillStyle = "#e63946";
    ctx.font = "20px Arial";
    ctx.fillText("♥", CANVAS_W - 10 - i * 22, 26);
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

  if (blink && Math.floor(Date.now() / 600) % 2 === 0) {
    ctx.fillStyle = "#ffd700";
    ctx.font = "bold 18px 'Courier New'";
    ctx.fillText("PRESS ENTER to play again", CANVAS_W / 2, CANVAS_H - 60);
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
  ctx.fillText("Collect coins  +100    Stomp enemies  +200", CANVAS_W / 2, 290);
  ctx.fillText("Reach the flag  +1000  Time bonus up to +2000", CANVAS_W / 2, 320);

  if (Math.floor(Date.now() / 600) % 2 === 0) {
    ctx.fillStyle = "#ffd700";
    ctx.font = "bold 22px 'Courier New'";
    ctx.fillText("PRESS SPACE TO START", CANVAS_W / 2, 420);
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
    for (const p of level.platforms) drawPlatform(p);
    for (const p of level.pipes)     drawPipe(p);
    for (const c of level.coins)     drawCoin(c);
    for (const e of level.enemies)   drawEnemy(e);
    drawFlag();
  }
  if (player) drawPlayer();
  drawHUD();
  drawPopups();

  if (state.phase === "gameover" || (state.phase === "submitting" && !state.won) || (state.phase === "done" && !state.won)) {
    drawOverlay("GAME OVER", "#e63946", [
      { text: `Score: ${state.score}` },
      { text: `Coins: ${state.coinsCollected}  Enemies: ${state.enemiesDefeated}` },
      { text: state.phase === "submitting" ? "Submitting score..." : "Score saved!", color: state.phase === "submitting" ? "#ffd700" : "#4caf50" },
    ], state.phase === "done");
  }

  if (state.phase === "win" || (state.phase === "submitting" && state.won) || (state.phase === "done" && state.won)) {
    drawOverlay("YOU WIN!", "#ffd700", [
      { text: `Final Score: ${state.score}` },
      { text: `Coins: ${state.coinsCollected}  Enemies: ${state.enemiesDefeated}` },
      { text: state.phase === "submitting" ? "Submitting score..." : "Score saved!", color: state.phase === "submitting" ? "#ffd700" : "#4caf50" },
    ], state.phase === "done");
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
  if (!state.sessionToken) { state.phase = "done"; await loadLeaderboard(); return; }

  state.phase = "submitting";

  if (!state.playerName) {
    const n = window.prompt("Your name for the leaderboard (max 12 chars):", "") || "Guest";
    state.playerName = n.trim().slice(0, 12) || "Guest";
    localStorage.setItem("marioName", state.playerName);
  }

  try {
    const res = await fetch(`${EDGE_BASE}/submit-score`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        sessionId      : state.sessionId,
        token          : state.sessionToken,
        name           : state.playerName,
        score          : state.score,
        coinsCollected : state.coinsCollected,
        enemiesDefeated: state.enemiesDefeated,
        won            : state.won,
        playTimeMs     : state.playTimeMs,
      }),
    });
    const result = await res.json();
    if (result.rank) console.log(`Leaderboard rank: #${result.rank}`);
  } catch (e) {
    console.warn("submitScore failed:", e.message);
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
  state.phase          = "playing";
}

function resetToStart() {
  state.phase        = "start";
  state.sessionId    = null;
  state.sessionToken = null;
}

// ============================================================
// INIT
// ============================================================
loadLeaderboard();
lastTs = performance.now();
requestAnimationFrame(gameLoop);
