"use strict";

// ============================================================
// CONFIG
// ============================================================
const CANVAS_W  = 800;
const CANVAS_H  = 560;
const TILE      = 40;
const GRAVITY   = 0.55;
const JUMP_FORCE = -13;
/** Super / fire forms jump this much higher than small Mario (green shrink keeps this). */
const JUMP_MULT_SUPER = 1.2;
const PLAYER_SMALL_W = 24;
const PLAYER_SMALL_H = 28;
const PLAYER_BIG_W   = 30;
const PLAYER_BIG_H   = 40;
/** Level geometry clearance — matches big Mario hitbox. */
const PLAYER_CLEAR_W = PLAYER_BIG_W;
const PLAYER_CLEAR_H = PLAYER_BIG_H;
const PLAYER_SPEED = 4.5;
/** Physics and speeds are tuned as “per frame at 60Hz”; multiply state by `dt * SIM_FPS` each step. */
const SIM_FPS = 60;
const NUM_LEVELS   = 10;
const LEVEL_SEG_W  = 10000;          // 10 segments ≈ 100000 world units to final flag
const WORLD_W      = NUM_LEVELS * LEVEL_SEG_W;
const GROUND_Y  = CANVAS_H - TILE;   // y where ground platforms start
const MUSHROOM_W = 24;
const MUSHROOM_H = 24;
const FIREBALL_SPEED = 10;
const FIRE_COOLDOWN_SEC = 21 / SIM_FPS;
const MUSHROOM_ALIVE_SEC = 5;
const RESPAWN_INVINCIBLE_MS = 3000;
/** How far left of max progress to respawn on death (surface). 5 tiles × TILE = 200px. */
const RESPAWN_SURFACE_BACK_TILES = 5;
const SEASON_DURATION_SEC = 10;
// ============================================================
// SUPABASE  — anon key only used for READ (leaderboard)
// Score writes go through Edge Functions which hold the secret.
// ============================================================
const SUPABASE_URL      = "https://mepescolmfmvtgbmdakw.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1lcGVzY29sbWZtdnRnYm1kYWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzNjY3MzUsImV4cCI6MjA5MTk0MjczNX0.1euG10m5Eq2gmRdlLRegdukKGWlvFs46gb_aJ8G8M8g";
const EDGE_BASE         = `${SUPABASE_URL}/functions/v1`;

/** CDN exposes `supabase` on globalThis with `createClient` (see package `jsdelivr` field). */
function tryCreateSupabaseClient() {
  if (SUPABASE_URL === "YOUR_SUPABASE_URL") return null;
  try {
    const g = typeof globalThis !== "undefined" ? globalThis : window;
    const mod = g.supabase;
    if (!mod || typeof mod.createClient !== "function") return null;
    return mod.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    });
  } catch (e) {
    console.warn("Supabase createClient:", e);
    return null;
  }
}

let sbClient = tryCreateSupabaseClient();

/** Top 10 scores via PostgREST when the JS client failed to init (same data as sb path). */
async function fetchLeaderboardTop10() {
  const q = new URLSearchParams({
    select: "name,score,created_at",
    order:  "score.desc,created_at.desc",
    limit:  "10",
  });
  const res = await fetch(`${SUPABASE_URL}/rest/v1/mario_scores?${q}`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`leaderboard HTTP ${res.status}`);
  return res.json();
}

// ============================================================
// CANVAS
// ============================================================
const canvas = document.getElementById("gameCanvas");
const ctx    = canvas.getContext("2d");
canvas.addEventListener("pointerdown", () => {
  try {
    canvas.focus({ preventScroll: true });
  } catch (_) {}
});

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
    fish      : [],
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
        vx: 1.4 * (0.3 + 1.7 * (px / WORLD_W)) * (dirRoll > 0.5 ? 1 : -1),
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
    const anchor = Math.floor(ex / TILE) * TILE;
    const seg = groundSegmentHorizontalBounds(out, anchor) ?? { minX: 0, maxX: WORLD_W };
    out.enemies.push({
      x: ex, y: GROUND_Y - TILE + 4,
      w: TILE - 6, h: TILE - 6,
      vx: 1.2 * (0.3 + 1.7 * (ex / WORLD_W)) * (dirRoll > 0.5 ? 1 : -1),
      minX: seg.minX,
      maxX: seg.maxX,
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
  const Q_MIN_Y = GROUND_Y - 168; // don’t float ? blocks too high (same RNG count as before)
  for (let i = 0; i < nQ; i++) {
    const qxRaw = 400 + Math.floor(rng() * (WORLD_W - 800));
    const qy = Math.max(Q_MIN_Y, GROUND_Y - 130 - Math.floor(rng() * 90));
    const q = pickQuestionBlockPlacement(qxRaw, qy, out, i);
    out.questionBlocks.push({
      x: q.x, y: q.y, w: TILE, h: TILE,
      emptied: false, bumpTimer: 0,
    });
  }

  ensurePassablePath(out);

  clampAllGroundEnemiesToSegments(out);

  addLateStageBrickPlatforms(out, seed);

  ensureMarioWidthClearanceNearPipes(out);

  // --- FISH (jump from water gaps; no RNG consumed — deterministic placement) ---
  for (let x = TILE * 20; x < WORLD_W - TILE * 15; x += TILE) {
    if (!out.groundSet.has(x)) {
      const seg = Math.floor(x / LEVEL_SEG_W);
      if (seg < 6 && Math.floor(x / TILE) % 2 !== 0) continue;
      out.fish.push({
        x: x + TILE / 2,
        baseY: GROUND_Y,
        y: GROUND_Y,        // tip of fish; moves up (decreasing y) when jumping
        vy: 0,
        w: 22, h: 20,
        alive: true,
        squished: false,
        squishTimer: 0,
        jumping: false,
        jumpTimer: Math.round(300 - 280 * Math.pow(x / WORLD_W, 3)) + (Math.floor(x / TILE) * 17) % 40,
      });
    }
  }

  return out;
}

function det01(seed, a, b) {
  let h = Math.imul((seed ^ (a * 374761393)) >>> 0, 2654435761) ^ Math.imul((b * 668265263) >>> 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h >>> 0) % 1000000) / 1000000;
}

/** Stages 7–10 only: extra narrow brick platforms (deterministic, no extra RNG — server score unchanged). */
function addLateStageBrickPlatforms(out, seed) {
  const SEG_MIN = 6;
  for (let seg = SEG_MIN; seg < NUM_LEVELS; seg++) {
    const minX = seg * LEVEL_SEG_W + 420;
    const maxX = (seg + 1) * LEVEL_SEG_W - 520;
    const count = 16 + seg * 2;
    for (let i = 0; i < count; i++) {
      const t = det01(seed, seg * 1999 + 7, i * 131);
      const rawX = minX + Math.floor(t * (maxX - minX - 240));
      const px = Math.floor(rawX / TILE) * TILE;
      const pyBand = det01(seed, seg * 541 + 3, i * 17);
      const py = GROUND_Y - 78 - Math.floor(pyBand * 165);
      const pwTiles = 2 + Math.floor(det01(seed, seg + 400, i * 91) * 3);
      const pw = pwTiles * TILE;
      let ok = true;
      for (const pipe of out.pipes) {
        if (overlap(px, py, pw, TILE, pipe.x, pipe.y, pipe.w, pipe.h)) { ok = false; break; }
      }
      if (!ok) continue;
      for (const q of out.questionBlocks) {
        if (overlap(px, py, pw, TILE, q.x, q.y, q.w, q.h)) { ok = false; break; }
      }
      if (!ok) continue;
      out.platforms.push({ x: px, y: py, w: pw, h: TILE, type: "brick" });
    }
  }
}

function getWorldWidth() {
  if (level && level.undergroundWidth) return level.undergroundWidth;
  return WORLD_W;
}

// One red warp-down pipe per stage segment (no extra RNG — post-pass only).
function markWarpPipes(lv) {
  for (const p of lv.pipes) p.warpDown = false;
  for (let seg = 0; seg < NUM_LEVELS; seg++) {
    const minX = seg * LEVEL_SEG_W + 700;
    const maxX = (seg + 1) * LEVEL_SEG_W - 900;
    const inSeg = lv.pipes.filter(p => p.x >= minX && p.x <= maxX);
    if (inSeg.length === 0) continue;
    inSeg.sort((a, b) => a.x - b.x);
    inSeg[0].warpDown = true;
  }
}

/**
 * Vertical rise (px) from one normal jump, matching update() (per frame: vy += GRAVITY*mult, y += vy).
 * Used to cap bonus-room exit climb vs pipe mouth.
 */
function maxJumpRisePx(jumpVy0, gravityMult) {
  let vy = jumpVy0;
  let y = 0;
  let minY = 0;
  for (let i = 0; i < 400; i++) {
    vy += GRAVITY * gravityMult;
    y += vy;
    if (y < minY) minY = y;
    if (vy > 0 && i > 3) break;
  }
  return -minY;
}

/** Normal small-Mario jump apex (px) at base gravity — defines bonus exit vertical gap vs pipe. */
const NORMAL_JUMP_RISE_PX = maxJumpRisePx(JUMP_FORCE * JUMP_MULT_SUPER, 1);
/** Vertical gap (px) from pipe bottom to last climb brick top: 30%–80% of that jump; keeps brick detached from pipe. */
const BONUS_EXIT_GAP_MIN_Y = Math.floor(NORMAL_JUMP_RISE_PX * 0.3);
const BONUS_EXIT_GAP_MAX_Y = Math.floor(NORMAL_JUMP_RISE_PX * 0.8);

function bonusExitBrickGapPx(segment) {
  const lo = BONUS_EXIT_GAP_MIN_Y;
  const hi = BONUS_EXIT_GAP_MAX_Y;
  if (hi <= lo) return lo;
  const u = det01(77331, segment, 12);
  return lo + Math.floor(u * (hi - lo));
}

/** Worst-case gravity (stage 10) so bonus gaps stay jumpable for the whole run. */
const BONUS_JUMP_TEST_GRAVITY_MULT = 1 + (NUM_LEVELS - 1) * 0.016;

/**
 * True if Mario can jump from the right edge of a platform at fromYTop onto
 * a target strip [gapX, gapX+toWidth] at toYTop (same frame order as update()).
 */
function undergroundBonusSimulateClear(gapX, fromYTop, toYTop, toWidth, gravityMult) {
  let px = -PLAYER_BIG_W;
  let py = fromYTop - PLAYER_BIG_H;
  let vy = JUMP_FORCE * JUMP_MULT_SUPER;
  const vx = PLAYER_SPEED;
  const bLeft = gapX;
  const bRight = gapX + toWidth;
  for (let f = 0; f < 520; f++) {
    vy += GRAVITY * gravityMult;
    if (vy > 18) vy = 18;
    px += vx;
    py += vy;
    const foot = py + PLAYER_BIG_H;
    if (foot >= toYTop - 5 && foot <= toYTop + 18 && vy >= -2) {
      if (px + PLAYER_BIG_W > bLeft + 3 && px < bRight - 3) return true;
    }
  }
  return false;
}

/** Max horizontal gap (px) from A’s right edge to B’s left while still landing on B (small Mario, running jump). */
function undergroundBonusMaxGapPx(fromYTop, toYTop, toW, gravityMult) {
  let lo = 0;
  let hi = 560;
  for (let it = 0; it < 12; it++) {
    const mid = (lo + hi + 1) >> 1;
    if (undergroundBonusSimulateClear(mid, fromYTop, toYTop, toW, gravityMult)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function isBonusWalkBrickPlatform(p) {
  if (p.type !== "brick") return false;
  if (p.w < TILE + 8) return false;
  if (p.w <= 12 && p.h > TILE * 4) return false;
  if (p.h > TILE * 10) return false;
  return true;
}

/** Insert evenly spaced bridge bricks so every gap between walk platforms is jumpable. */
function ensureUndergroundBonusJumpableGaps(platforms, uw) {
  const gMult = BONUS_JUMP_TEST_GRAVITY_MULT;
  const bridgeW = TILE * 2;
  for (let pass = 0; pass < 24; pass++) {
    const planks = platforms.filter(isBonusWalkBrickPlatform).sort((a, b) => a.x - b.x);
    let fixed = false;
    for (let i = 0; i < planks.length - 1; i++) {
      const A = planks[i];
      const B = planks[i + 1];
      const gapX = B.x - (A.x + A.w);
      if (gapX <= 16) continue;
      const maxG = undergroundBonusMaxGapPx(A.y, B.y, B.w, gMult);
      if (gapX <= maxG + 10) continue;

      let n = 0;
      while (n <= 18) {
        const span = gapX - n * bridgeW;
        if (span <= 0) {
          n = Math.max(0, n - 1);
          break;
        }
        if (span / (n + 1) <= maxG + 10) break;
        n++;
      }
      let span = gapX - n * bridgeW;
      let useW = bridgeW;
      if (span <= 0 && n > 0) {
        n--;
        span = gapX - n * bridgeW;
      }
      if (span <= 0) {
        useW = Math.max(TILE, Math.min(bridgeW, gapX - Math.floor(maxG * 0.5) - 8));
        if (useW < TILE || gapX - useW > maxG + 10) continue;
        n = 1;
        span = gapX - useW;
      }
      const g0 = span / (n + 1);
      const by = Math.min(A.y, B.y);
      let placedAny = false;
      for (let k = 0; k < n; k++) {
        let bx = Math.floor(A.x + A.w + (k + 1) * g0 + k * useW);
        bx = Math.floor(bx / TILE) * TILE;
        if (bx < TILE) bx = TILE;
        if (bx + useW > uw - TILE) bx = Math.max(TILE, uw - TILE - useW);
        let clash = false;
        for (const q of platforms) {
          if (q.type === "ground") continue;
          if (overlap(bx, by, useW, TILE, q.x, q.y, q.w, q.h)) {
            clash = true;
            break;
          }
        }
        if (!clash) {
          platforms.push({ x: bx, y: by, w: useW, h: TILE, type: "brick" });
          placedAny = true;
        }
      }
      if (placedAny) {
        fixed = true;
        break;
      }
    }
    if (!fixed) break;
  }
}

/** Each surface stage (0–9) has a distinct bonus room. `dy` = pixels above ground for platform top / coin height. */
function makeBonusRoom(segment, uw, stemLen, brickSpecs, coinSpecs) {
  const groundSet = new Set();
  const platforms = [];
  for (let x = 0; x < uw; x += TILE) {
    groundSet.add(x);
    platforms.push({ x, y: GROUND_Y, w: TILE, h: TILE * 3, type: "ground" });
  }
  const brick = (x, y, w, h = TILE) => {
    platforms.push({ x, y, w, h, type: "brick" });
  };
  for (const b of brickSpecs) {
    const h = b[3] != null ? b[3] : TILE;
    brick(b[0], GROUND_Y - b[1], b[2], h);
  }
  const pipeW = TILE * 2;
  const exitPipeH = stemLen + TILE * 2;

  let exitBrick = null;
  for (const b of brickSpecs) {
    const bw = b[2];
    const bx = b[0];
    const dy = b[1];
    const bh = b[3] != null ? b[3] : TILE;
    const right = bx + bw;
    if (!exitBrick || right > exitBrick.right || (right === exitBrick.right && dy > exitBrick.dy)) {
      exitBrick = { x: bx, w: bw, dy, right, h: bh };
    }
  }

  const exitX = Math.floor(Math.max(TILE, uw - pipeW - 8));

  if (exitBrick) {
    const gapPx = bonusExitBrickGapPx(segment);
    const brickTopY = exitPipeH + gapPx;
    const pipeCx = exitX + pipeW / 2;
    let bx = Math.floor((pipeCx - exitBrick.w / 2) / TILE) * TILE;
    bx = Math.max(0, Math.min(bx, uw - exitBrick.w));
    const naturalTop = GROUND_Y - exitBrick.dy;
    for (const p of platforms) {
      if (p.type !== "brick") continue;
      if (p.x !== exitBrick.x || p.w !== exitBrick.w || p.h !== exitBrick.h) continue;
      if (Math.abs(p.y - naturalTop) > 0.5) continue;
      p.x = bx;
      p.y = brickTopY;
      p.bonusExitRow = true;
      break;
    }
  }
  brick(exitX, TILE, 8, stemLen + TILE);
  brick(exitX + pipeW - 8, TILE, 8, stemLen + TILE);
  const pipes = [{
    x: exitX,
    y: 0,
    w: pipeW,
    h: exitPipeH,
    warpUp: true,
    ceilingExit: true,
  }];
  const coins = coinSpecs.map(([cx, dy]) => ({ x: cx, y: GROUND_Y - dy, r: false, bonusOnly: true }));

  ensureUndergroundBonusJumpableGaps(platforms, uw);

  return {
    platforms,
    coins,
    enemies: [],
    pipes,
    questionBlocks: [],
    mushrooms: [],
    fish: [],
    groundSet,
    coinCount: 0,
    enemyCount: 0,
    undergroundWidth: uw,
    isUnderground: true,
    bonusStarTotal: coins.length,
    bonusSegment: segment,
  };
}

function buildUndergroundBonus(segmentIndex = 0) {
  const seg = ((segmentIndex | 0) % NUM_LEVELS + NUM_LEVELS) % NUM_LEVELS;
  const S = (n) => Math.max(22, Math.min(36, n));
  switch (seg) {
    case 0:
      return makeBonusRoom(seg, 2700, S(28), [
        [180, 88, 200], [460, 138, 140], [700, 98, 220], [980, 178, 160],
        [1240, 128, 130], [1500, 208, 180], [1760, 158, 120], [2020, 238, 150],
        [2280, 188, 100], [2480, 268, 120], [2580, 328, 90],
      ], [[320, 118], [620, 168], [900, 128], [1320, 218], [1720, 238], [2100, 258], [2440, 288]]);
    case 1:
      return makeBonusRoom(seg, 2650, S(26), [
        [220, 75, 260], [560, 145, 100], [780, 105, 180], [1080, 185, 200],
        [1380, 135, 140], [1680, 215, 160], [1920, 165, 100], [2180, 245, 140],
        [2380, 195, 120], [2520, 285, 100],
      ], [[380, 105], [700, 175], [1020, 135], [1540, 225], [1860, 185], [2260, 255], [2460, 305]]);
    case 2:
      return makeBonusRoom(seg, 2900, S(30), [
        [160, 95, 160], [380, 155, 120], [560, 115, 200], [820, 195, 140],
        [1040, 145, 130], [1280, 225, 170], [1540, 175, 150], [1780, 255, 120],
        [2000, 205, 180], [2260, 285, 130], [2460, 235, 100], [2620, 315, 110],
      ], [[300, 125], [640, 185], [940, 135], [1180, 235], [1620, 255], [1940, 215], [2340, 295], [2680, 335]]);
    case 3:
      return makeBonusRoom(seg, 2750, S(24), [
        [200, 110, 100], [340, 150, 100], [480, 190, 100], [620, 230, 100],
        [900, 160, 220], [1200, 200, 160], [1460, 240, 140], [1720, 180, 200],
        [2000, 260, 120], [2220, 220, 100], [2420, 300, 130],
      ], [[260, 140], [420, 220], [760, 190], [1120, 230], [1380, 270], [1780, 210], [2080, 290], [2480, 330]]);
    case 4:
      return makeBonusRoom(seg, 2600, S(32), [
        [240, 70, 320], [620, 120, 140], [860, 160, 180], [1120, 130, 160],
        [1380, 200, 200], [1660, 150, 120], [1900, 210, 160], [2140, 170, 140],
        [2360, 250, 120],
      ], [[400, 100], [780, 150], [1100, 180], [1480, 220], [1820, 190], [2220, 270], [2460, 230]]);
    case 5:
      return makeBonusRoom(seg, 2850, S(27), [
        [150, 85, 170], [400, 135, 150], [620, 95, 210], [900, 175, 130],
        [1120, 125, 190], [1380, 205, 150], [1600, 155, 170], [1860, 235, 100],
        [2060, 185, 200], [2320, 265, 120], [2520, 215, 160], [2740, 295, 90],
      ], [[280, 115], [520, 165], [800, 125], [1250, 210], [1520, 185], [1920, 250], [2200, 200], [2580, 290]]);
    case 6:
      return makeBonusRoom(seg, 2720, S(29), [
        [190, 100, 200], [460, 180, 120], [640, 120, 240], [940, 200, 140],
        [1180, 140, 160], [1420, 220, 180], [1700, 160, 120], [1900, 240, 200],
        [2180, 190, 100], [2380, 270, 140], [2580, 220, 100],
      ], [[340, 130], [600, 210], [880, 150], [1280, 230], [1560, 190], [2000, 260], [2280, 210], [2520, 285]]);
    case 7:
      return makeBonusRoom(seg, 2950, S(25), [
        [170, 78, 150], [360, 118, 150], [550, 158, 150], [740, 198, 150],
        [1000, 128, 280], [1340, 168, 140], [1560, 208, 160], [1800, 148, 220],
        [2100, 228, 120], [2320, 178, 180], [2560, 258, 140], [2780, 308, 100],
      ], [[250, 108], [480, 188], [820, 138], [1180, 198], [1460, 238], [1740, 178], [2060, 248], [2420, 288], [2760, 328]]);
    case 8:
      return makeBonusRoom(seg, 2680, S(31), [
        [210, 92, 280], [560, 142, 120], [760, 112, 200], [1040, 172, 240],
        [1360, 132, 160], [1600, 192, 180], [1860, 152, 140], [2080, 232, 200],
        [2360, 182, 160],
      ], [[350, 122], [680, 162], [920, 142], [1280, 202], [1720, 222], [1980, 182], [2240, 252]]);
    default:
      return makeBonusRoom(seg, 2800, S(26), [
        [200, 80, 190], [450, 130, 170], [680, 100, 200], [940, 170, 210],
        [1220, 120, 150], [1460, 200, 180], [1720, 150, 160], [1960, 230, 140],
        [2200, 180, 200], [2480, 260, 120], [2660, 220, 100], [2760, 300, 100],
      ], [[310, 110], [580, 160], [860, 130], [1140, 200], [1380, 180], [1660, 240], [2060, 210], [2380, 280], [2700, 320]]);
  }
}

function exitUnderground() {
  if (performance.now() < pipeWarpLockUntil || !surfaceSave) return;
  level = surfaceLevelRef;
  surfaceLevelRef = null;
  const p = surfaceSave.pipe;
  player.x = p.x + p.w / 2 - player.w / 2;
  player.y = p.y - player.h;
  player.vx = 0;
  player.vy = 0;
  camX = Math.max(0, Math.min(surfaceSave.camX, WORLD_W - CANVAS_W));
  surfaceSave = null;
  state.layer = "surface";
  pipeWarpLockUntil = performance.now() + 500;
}

function tryPipeWarpEnter() {
  if (state.layer !== "surface" || !level || !player) return;
  if (performance.now() < pipeWarpLockUntil) return;
  if (state.pipeWarpAnim) return;
  if (keys["ShiftLeft"] || keys["ShiftRight"]) return;
  if (!keys["ArrowDown"] && !keys["KeyS"]) return;
  for (const pipe of level.pipes) {
    if (!pipe.warpDown) continue;
    if (!player.onGround) continue;
    const feet = player.y + player.h;
    if (Math.abs(feet - pipe.y) > 10) continue;
    const hc = player.x + player.w / 2;
    if (hc < pipe.x + 10 || hc > pipe.x + pipe.w - 10) continue;
    surfaceLevelRef = level;
    surfaceSave = {
      camX,
      pipe,
      segment: Math.min(NUM_LEVELS - 1, Math.max(0, Math.floor(pipe.x / LEVEL_SEG_W))),
    };
    const endY = Math.min(pipe.y + TILE + 96, pipe.y + pipe.h - 28);
    state.pipeWarpAnim = {
      kind: "down",
      elapsed: 0,
      dur: 0.58,
      pipe,
      startY: player.y,
      endY,
    };
    player.vx = 0;
    player.vy = 0;
    return;
  }
}

function tryPipeWarpExit() {
  if (state.layer !== "underground" || !level || !player) return;
  if (performance.now() < pipeWarpLockUntil) return;
  if (state.pipeWarpAnim) return;
  for (const pipe of level.pipes) {
    if (!pipe.warpUp || !pipe.ceilingExit) continue;
    const touchX = pipe.x + 2;
    const touchW = pipe.w - 4;
    const touchY = pipe.y;
    const touchH = Math.min(TILE * 5 + 8, Math.max(TILE * 2, pipe.h - 24));
    if (!overlap(player.x, player.y, player.w, player.h, touchX, touchY, touchW, touchH)) continue;
    if (player.vy > 2) continue;
    state.pipeWarpAnim = {
      kind: "up",
      elapsed: 0,
      dur: 0.58,
      pipe,
      startY: player.y,
      endY: pipe.y - player.h - 16,
    };
    player.x = pipe.x + pipe.w / 2 - player.w / 2;
    player.vx = 0;
    player.vy = 0;
    return;
  }
}

function updatePipeWarpAnim(dt) {
  const w = state.pipeWarpAnim;
  if (!w || !player) return;
  if (w.kind === "down") {
    w.elapsed += dt;
    const p = w.pipe;
    const u = Math.min(1, w.elapsed / w.dur);
    const s = u * u * (3 - 2 * u);
    player.y = w.startY + (w.endY - w.startY) * s;
    player.x = p.x + p.w / 2 - player.w / 2;
    player.vx = 0;
    player.vy = 0;
    player.onGround = false;
    if (u >= 1) {
      level = buildUndergroundBonus(surfaceSave ? surfaceSave.segment : 0);
      player.x = 70;
      player.y = GROUND_Y - player.h;
      player.vx = 0;
      player.vy = 0;
      camX = 0;
      fireballs = [];
      state.layer = "underground";
      state.pipeWarpAnim = null;
      pipeWarpLockUntil = performance.now() + 500;
      addPopup(CANVAS_W / 2, 100, "BONUS ROOM");
    }
  } else if (w.kind === "up") {
    w.elapsed += dt;
    const p = w.pipe;
    const u = Math.min(1, w.elapsed / w.dur);
    const s = u * u * (3 - 2 * u);
    player.y = w.startY + (w.endY - w.startY) * s;
    player.x = p.x + p.w / 2 - player.w / 2;
    player.vx = 0;
    player.vy = 0;
    player.onGround = false;
    if (u >= 1) {
      exitUnderground();
      state.pipeWarpAnim = null;
      pipeWarpLockUntil = performance.now() + 500;
    }
  }
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

/** Horizontal gap from rect A’s right to rect B’s left (A left of B). Returns -1 if not separated left/right. */
function horizontalGapLeftToRight(aL, aR, bL, bR) {
  if (aR <= bL) return bL - aR;
  if (bR <= aL) return aL - bR;
  return -1;
}

function verticalRangesOverlap(aTop, aBot, bTop, bBot) {
  return aTop < bBot && aBot > bTop;
}

/**
 * Pipes, bricks, and other ? blocks: in a vertical band around the ? block, any side-by-side
 * pair must leave at least PLAYER_CLEAR_W horizontal gap (or no solid overlap) so the path stays playable.
 */
function questionBlockMarioSidewallClearanceOk(qx, qy, out, selfQ) {
  const CLEAR = PLAYER_CLEAR_W;
  const vPad = 12;
  const qTop = qy - vPad;
  const qBot = qy + TILE + vPad;

  for (const pipe of out.pipes) {
    const pTop = pipe.y;
    const pBot = pipe.y + pipe.h;
    if (!verticalRangesOverlap(qTop, qBot, pTop, pBot)) continue;
    const g = horizontalGapLeftToRight(qx, qx + TILE, pipe.x, pipe.x + pipe.w);
    if (g >= 0 && g < CLEAR) return false;
    if (g < 0 && overlap(qx, qy, TILE, TILE, pipe.x, pipe.y, pipe.w, pipe.h)) return false;
  }
  for (const pl of out.platforms) {
    if (pl.type !== "brick") continue;
    const pTop = pl.y;
    const pBot = pl.y + pl.h;
    if (!verticalRangesOverlap(qTop, qBot, pTop, pBot)) continue;
    const g = horizontalGapLeftToRight(qx, qx + TILE, pl.x, pl.x + pl.w);
    if (g >= 0 && g < CLEAR) return false;
    if (g < 0 && overlap(qx, qy, TILE, TILE, pl.x, pl.y, pl.w, pl.h)) return false;
  }
  for (const other of out.questionBlocks) {
    if (selfQ && other === selfQ) continue;
    const oTop = other.y;
    const oBot = other.y + other.h;
    if (!verticalRangesOverlap(qTop, qBot, oTop, oBot)) continue;
    const g = horizontalGapLeftToRight(qx, qx + TILE, other.x, other.x + other.w);
    if (g >= 0 && g < CLEAR) return false;
    if (g < 0 && overlap(qx, qy, TILE, TILE, other.x, other.y, other.w, other.h)) return false;
  }
  return true;
}

/** Full validation for ? placement (shared by generation and post-pass nudges). */
function questionBlockPlacementValid(out, qx, qy, selfQ) {
  if (!hasSupportForQuestionBlock(out, qx, qy)) return false;
  if (!questionBlockConnectsToBrick(out, qx, qy)) return false;
  if (questionBlockOverlapsPipe(qx, qy, out.pipes)) return false;
  if (!questionBlockMarioSidewallClearanceOk(qx, qy, out, selfQ)) return false;
  const patched = selfQ
    ? {
        ...out,
        questionBlocks: out.questionBlocks.map(qb =>
          qb === selfQ ? { ...qb, x: qx, y: qy } : qb
        ),
      }
    : out;
  if (questionBlockPipeSandwich(patched, qx, qy)) return false;
  return true;
}

/**
 * Post-processing: min horizontal gap PLAYER_CLEAR_W between pipes and floating bricks / ? blocks
 * so Mario can pass (fixes tight slots next to pipe stems, e.g. early stages).
 */
function ensureMarioWidthClearanceNearPipes(out) {
  const CLEAR = PLAYER_CLEAR_W;
  const pipes = out.pipes;
  if (!pipes || pipes.length === 0) return;

  const fixBrickVsPipe = (br, pipe) => {
    const pL = pipe.x;
    const pR = pipe.x + pipe.w;
    const bL = br.x;
    const bR = br.x + br.w;
    const gap = horizontalGapLeftToRight(bL, bR, pL, pR);
    if (gap >= 0 && gap < CLEAR) {
      if (bR <= pL) {
        br.w = Math.max(TILE, pL - br.x - CLEAR);
      } else if (pR <= bL) {
        const nx = pR + CLEAR;
        br.w = Math.max(TILE, bR - nx);
        br.x = nx;
      }
      return;
    }
    if (gap < 0) {
      const leftChunkW = pL - CLEAR - bL;
      const rightChunkW = bR - (pR + CLEAR);
      if (leftChunkW >= TILE && leftChunkW >= rightChunkW) {
        br.w = leftChunkW;
      } else if (rightChunkW >= TILE) {
        br.x = pR + CLEAR;
        br.w = rightChunkW;
      } else if (leftChunkW >= TILE) {
        br.w = leftChunkW;
      } else if (rightChunkW > 0) {
        br.x = pR + CLEAR;
        br.w = Math.max(TILE, rightChunkW);
      } else if (leftChunkW > 0) {
        br.w = Math.max(TILE, leftChunkW);
      } else {
        br.x = pR + CLEAR;
        br.w = TILE;
      }
    }
  };

  const bricks = out.platforms.filter(p => p.type === "brick");
  for (let pass = 0; pass < 4; pass++) {
    for (const br of bricks) {
      for (const pipe of pipes) fixBrickVsPipe(br, pipe);
    }
  }

  const canPlaceQuestionAtX = (q, nx) => questionBlockPlacementValid(out, nx, q.y, q);

  for (const q of out.questionBlocks) {
    if (canPlaceQuestionAtX(q, q.x)) continue;
    const baseX = q.x;
    let placed = false;
    for (let radius = 1; radius <= 40 && !placed; radius++) {
      const tryNx = (nx) => {
        if (nx < 280 || nx > WORLD_W - 400) return false;
        if (canPlaceQuestionAtX(q, nx)) {
          q.x = nx;
          return true;
        }
        return false;
      };
      placed = tryNx(Math.floor((baseX - radius * TILE) / TILE) * TILE)
        || tryNx(Math.floor((baseX + radius * TILE) / TILE) * TILE);
    }
  }

  for (const e of out.enemies) {
    if (e.groundBound) continue;
    const cx = e.x + e.w / 2;
    for (const br of out.platforms) {
      if (br.type !== "brick") continue;
      if (Math.abs(e.y + e.h - br.y) > 10) continue;
      if (cx < br.x || cx > br.x + br.w) continue;
      e.minX = br.x;
      e.maxX = br.x + br.w;
      const margin = 4;
      e.x = Math.min(Math.max(e.x, br.x + margin), br.x + br.w - e.w - margin);
      break;
    }
  }
}

function questionBlockOverlapsPipe(qx, qy, pipes) {
  for (const pipe of pipes) {
    if (overlap(qx, qy, TILE, TILE, pipe.x, pipe.y, pipe.w, pipe.h)) return true;
  }
  return false;
}

/** True if ? block sits in a tight vertical slot above a pipe lip (hard to hit / blocks path). */
function questionBlockPipeSandwich(out, qx, qy) {
  const hb = qy + TILE;
  for (const pipe of out.pipes) {
    if (qx + TILE <= pipe.x || qx >= pipe.x + pipe.w) continue;
    if (overlap(qx, qy, TILE, TILE, pipe.x, pipe.y, pipe.w, pipe.h)) return true;
    // Block bottom just above pipe top — classic stuck spot between pipe and platform above
    if (hb <= pipe.y + 6 && hb > pipe.y - 72) {
      for (const pl of out.platforms) {
        if (pl.type !== "brick") continue;
        if (qx + TILE <= pl.x || qx >= pl.x + pl.w) continue;
        if (pl.y + pl.h > qy - 8 && pl.y < qy + TILE + 12) return true;
      }
    }
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

/** Contiguous ground run containing tileX (tile-aligned); null if tile not grounded. */
function groundSegmentHorizontalBounds(out, tileX) {
  const L = Math.floor(tileX / TILE) * TILE;
  if (!out.groundSet.has(L)) return null;
  let left = L;
  while (left >= TILE && out.groundSet.has(left - TILE)) left -= TILE;
  let right = L;
  while (right + TILE < WORLD_W && out.groundSet.has(right + TILE)) right += TILE;
  return { minX: left, maxX: right + TILE };
}

/** Keep ground-bound goombas on their ground island (never out over water/gaps). */
function clampAllGroundEnemiesToSegments(out) {
  for (const e of out.enemies) {
    if (!e.groundBound) continue;
    const anchor = Math.floor((e.x + e.w * 0.5) / TILE) * TILE;
    const seg = groundSegmentHorizontalBounds(out, anchor);
    if (!seg) continue;
    e.minX = seg.minX;
    e.maxX = seg.maxX;
    const margin = 2;
    e.x = Math.min(Math.max(e.x, seg.minX + margin), seg.maxX - e.w - margin);
  }
}

/** ? block shares an edge with a normal brick (same row neighbor or stacked on brick). */
function questionBlockConnectsToBrick(out, qx, qy) {
  const tol = 8;
  for (const pl of out.platforms) {
    if (pl.type !== "brick") continue;
    if (qx + TILE <= pl.x || qx >= pl.x + pl.w) {
      if (pl.y + pl.h < qy - tol || pl.y > qy + TILE + tol) continue;
      const gapL = pl.x - (qx + TILE);
      const gapR = qx - (pl.x + pl.w);
      if ((gapL >= 0 && gapL <= tol) || (gapR >= 0 && gapR <= tol)) return true;
      continue;
    }
    if (pl.y >= qy + TILE - tol && pl.y <= qy + TILE + tol) return true;
    if (Math.abs(pl.y - qy) <= tol && (qx + TILE > pl.x && qx < pl.x + pl.w)) return true;
  }
  return false;
}

/** Ground under ? OR ? stacked on a brick top (floating rows). */
function hasSupportForQuestionBlock(out, qx, qy) {
  if (hasStandableSupportUnder(out, qx, TILE, qy)) return true;
  const bot = qy + TILE;
  for (const pl of out.platforms) {
    if (pl.type !== "brick") continue;
    if (Math.abs(pl.y - bot) <= 8 && qx + TILE > pl.x && qx < pl.x + pl.w) return true;
  }
  return false;
}

function pickQuestionBlockPlacement(qxRaw, qy, out, blockIndex = 0) {
  const tryX = (qx) => {
    if (!questionBlockPlacementValid(out, qx, qy, null)) return null;
    return { x: qx, y: qy };
  };
  const byDistThenX = (a, b) =>
    Math.abs(a - qxRaw) - Math.abs(b - qxRaw) || a - b;

  const tiles = [...out.groundSet].filter(x => x >= 320 && x < WORLD_W - 200)
    .sort(byDistThenX);
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
  for (const t of [...out.groundSet].filter(x => x >= 320 && x < WORLD_W - 200).sort((a, b) => a - b)) {
    const ok = tryX(t);
    if (ok) return ok;
  }
  for (const t of [...out.groundSet].filter(x => x >= 280 && x < WORLD_W - 200).sort((a, b) => a - b)) {
    const ok = tryX(t);
    if (ok) return ok;
  }
  for (const pl of out.platforms) {
    if (pl.type !== "brick") continue;
    const candidates = [pl.x - TILE, pl.x, pl.x + Math.floor((pl.w - TILE) / 2), pl.x + pl.w - TILE, pl.x + pl.w];
    for (const raw of candidates) {
      const qx = Math.floor(raw / TILE) * TILE;
      if (qx < 280 || qx > WORLD_W - 400) continue;
      const ok = tryX(qx);
      if (ok) return ok;
    }
  }
  for (let qx = 320; qx < WORLD_W - 400; qx += TILE) {
    const ok = tryX(qx);
    if (ok) return ok;
  }
  const span = Math.max(TILE, WORLD_W - 400 - 320);
  const slot = ((blockIndex * 137 + Math.floor(qxRaw / TILE)) * TILE) % span;
  return { x: 320 + slot, y: qy };
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
  layer         : "surface", // surface | underground (bonus room)
  bonusStars    : 0,    // decorative pickups in bonus (not sent to leaderboard math)
  lastRank      : null, // leaderboard rank from last submit (#N)
  lastSubmitError: null, // set when session missing or submit-score returns an error (shown on overlay)
  pipeWarpAnim  : null, // { kind: 'down'|'up', ... } — blocks normal physics while active
};

let level   = null;
let player  = null;
let camX    = 0;
let coinSpin = 0;
let lastTs  = 0;
let fireballs = [];
let nameAskedThisPageLoad = false;
/** Secret test: Shift+J+O toggles autopilot; Shift+J+O+N skips +500px; Shift+G+O game over + score submit; Shift+B+H +1 life (either order); Shift+S+1–9/0 jumps to stage 1–10. */
let autoPilot = false;
let autoPilotJumpCooldown = 0;
let autoPilotRetreatLeft = 0;
let autoPilotLastX = 0;
let autoPilotNoMoveAccum = 0;
let surfaceLevelRef = null;
let surfaceSave     = null;
let pipeWarpLockUntil = 0;

function forceGameOverSubmit() {
  if (state.phase !== "playing") return;
  state.lives = 0;
  state.playTimeMs = Date.now() - state.runStartMs;
  state.phase = "gameover";
  submitScore();
}

function skipTesterForward500() {
  if (!player || !level || state.phase !== "playing") return;
  if (state.layer !== "surface") return;
  state.pipeWarpAnim = null;
  let nx = Math.min(player.x + 500, WORLD_W - player.w);
  const tileX = Math.floor(nx / TILE) * TILE;
  let tx = tileX;
  if (!level.groundSet.has(tx)) {
    let found = false;
    for (let d = 0; d < 80; d++) {
      const a = tileX + d * TILE;
      const b = tileX - d * TILE;
      if (a < WORLD_W && level.groundSet.has(a)) { tx = a; found = true; break; }
      if (b >= 0 && level.groundSet.has(b)) { tx = b; found = true; break; }
    }
    if (!found) tx = Math.max(0, tileX);
  }
  player.x = Math.min(tx + 6, WORLD_W - player.w);
  player.y = GROUND_Y - player.h;
  player.vx = 0;
  player.vy = 0;
  player.onGround = true;
  if (player.x > player.maxX) player.maxX = player.x;
  camX = Math.max(0, Math.min(player.x - CANVAS_W / 3, WORLD_W - CANVAS_W));
}

/** Leftmost solid ground tile in this stage segment (surface world). */
function findFirstGroundTileInSegment(seg) {
  if (!level || !level.groundSet) return seg * LEVEL_SEG_W;
  const xMin = seg * LEVEL_SEG_W;
  const xMax = Math.min((seg + 1) * LEVEL_SEG_W, WORLD_W);
  for (let tx = Math.floor(xMin / TILE) * TILE; tx < xMax; tx += TILE) {
    if (level.groundSet.has(tx)) return tx;
  }
  for (let tx = Math.floor(xMin / TILE) * TILE; tx < WORLD_W; tx += TILE) {
    if (level.groundSet.has(tx)) return tx;
  }
  return Math.max(0, Math.floor(xMin / TILE) * TILE);
}

function jumpToTestStage(stage1to10) {
  if (!player || state.phase !== "playing") return;
  const n = Math.floor(stage1to10);
  if (n < 1 || n > NUM_LEVELS) return;
  const seg = n - 1;

  state.pipeWarpAnim = null;
  if (state.layer === "underground") {
    if (!surfaceLevelRef) return;
    level = surfaceLevelRef;
    surfaceLevelRef = null;
    surfaceSave = null;
    state.layer = "surface";
    fireballs = [];
  }
  if (!level || level.undergroundWidth) return;

  state.flagsPassed = seg;
  const tx = findFirstGroundTileInSegment(seg);
  player.x = Math.min(tx + 6, WORLD_W - player.w);
  player.y = GROUND_Y - player.h;
  player.vx = 0;
  player.vy = 0;
  player.onGround = true;
  player.maxX = Math.max(80, player.x);
  camX = Math.max(0, Math.min(seg * LEVEL_SEG_W, WORLD_W - CANVAS_W));
  pipeWarpLockUntil = performance.now() + 500;
  state.score += 2000;
  addPopup(CANVAS_W / 2, 100, `STAGE ${n}`);
  addPopup(CANVAS_W / 2, 128, "+2000");
}

function getPlayerJumpVy0() {
  if (!player) return JUMP_FORCE;
  return JUMP_FORCE * (player.powerStage >= 1 ? JUMP_MULT_SUPER : 1);
}

function syncPlayerHitbox(keepFeet) {
  if (!player) return;
  const wantBig = player.powerStage >= 1 && !player.greenShrink;
  const nh = wantBig ? PLAYER_BIG_H : PLAYER_SMALL_H;
  const nw = wantBig ? PLAYER_BIG_W : PLAYER_SMALL_W;
  if (player.w === nw && player.h === nh) return;
  const prevH = player.h;
  player.w = nw;
  player.h = nh;
  if (keepFeet) player.y += prevH - nh;
}

function createPlayer() {
  return {
    x: 80, y: GROUND_Y - PLAYER_SMALL_H,
    vx: 0, vy: 0,
    w: PLAYER_SMALL_W, h: PLAYER_SMALL_H,
    onGround: false,
    alive: true,
    invincibleUntilMs: 0,
    facingRight: true,
    walkFrame: 0,
    walkTimer: 0,
    maxX: 80,
    powerStage: 0,
    greenShrink: false,
    fireCooldown: 0,
  };
}

// ============================================================
// INPUT
// ============================================================
const keys = {};
const isMobile = window.matchMedia("(hover: none) and (pointer: coarse)").matches;

/** Shift+S+main-row or numpad digit → stage 1–10 (0 = stage 10). */
function parseTestStageKeyCode(code) {
  let tail;
  if (code.startsWith("Digit")) tail = code.slice(5);
  else if (code.startsWith("Numpad") && code.length === 7) tail = code.slice(6);
  else return null;
  if (tail === "0") return 10;
  const n = parseInt(tail, 10);
  return n >= 1 && n <= 9 ? n : null;
}

window.addEventListener("keydown", e => {
  keys[e.code] = true;
  if (!e.repeat && e.shiftKey && e.code === "KeyO" && keys["KeyG"]) {
    forceGameOverSubmit();
    e.preventDefault();
  } else if (!e.repeat && e.shiftKey && e.code === "KeyO" && keys["KeyJ"]) {
    autoPilot = !autoPilot;
    if (autoPilot && state.phase === "playing") state.lives = 999;
    e.preventDefault();
  } else if (!e.repeat && e.shiftKey && state.phase === "playing" &&
      ((e.code === "KeyH" && keys["KeyB"]) || (e.code === "KeyB" && keys["KeyH"]))) {
    // Shift+B+H (like Shift+G+O): works whether you press B or H first while holding Shift.
    state.lives++;
    addPopup(CANVAS_W / 2, 108, "+1 UP");
    e.preventDefault();
  }
  if (!e.repeat && e.shiftKey && e.code === "KeyN" && keys["KeyJ"] && keys["KeyO"]) {
    skipTesterForward500();
    e.preventDefault();
  }
  if (!e.repeat && e.shiftKey && state.phase === "playing") {
    let stage = null;
    const fromDigit = parseTestStageKeyCode(e.code);
    if (fromDigit != null && keys["KeyS"]) stage = fromDigit;
    else if (e.code === "KeyS") {
      for (let i = 0; i <= 9; i++) {
        const dc = "Digit" + i;
        const nc = "Numpad" + i;
        if (keys[dc] || keys[nc]) {
          stage = i === 0 ? 10 : i;
          break;
        }
      }
    }
    if (stage != null && stage >= 1 && stage <= NUM_LEVELS) {
      jumpToTestStage(stage);
      e.preventDefault();
    }
  }
  if (["Space","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.code)) e.preventDefault();
  if (state.phase === "start" && (e.code === "Space" || e.code === "Enter")) startGame();
  if ((state.phase === "done" || state.phase === "gameover") && (e.code === "Enter" || e.code === "Space")) resetToStart();
}, true);
window.addEventListener("keyup", e => { keys[e.code] = false; });

// Touch controls
function setupTouchControls() {
  const btnLeft  = document.getElementById("touch-left");
  const btnRight = document.getElementById("touch-right");
  const btnJump  = document.getElementById("touch-jump");
  const btnFire  = document.getElementById("touch-fire");
  const btnDown  = document.getElementById("touch-down");

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
  if (btnDown) bindBtn(btnDown, "ArrowDown");
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

function playerRespawnInvincibleNow() {
  return !autoPilot && performance.now() < player.invincibleUntilMs;
}

/** Stomp kill: normal falling hit, or during post-death i-frames allow standing on top without vy check. */
function canStompGroundEnemy(player, e) {
  const foot = player.y + player.h;
  if (player.vy > 0 && foot < e.y + 16) return true;
  if (playerRespawnInvincibleNow() && foot <= e.y + 22 && foot < e.y + e.h * 0.48) return true;
  return false;
}

function canStompFish(player, f) {
  const foot = player.y + player.h;
  if (player.vy > 0 && foot < f.y + f.h * 0.5) return true;
  if (playerRespawnInvincibleNow() && foot <= f.y + 16 && foot < f.y + f.h * 0.52) return true;
  return false;
}

function resolveVsBoxes(boxes) {
  for (const b of boxes) {
    if (b.ceilingExit) continue;
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
  const type = Math.random() < 0.5 ? "power" : "green";
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
    type,
  });
}

// ============================================================
// SCORE POPUP
// ============================================================
function addPopup(x, y, text) {
  state.popups.push({ x, y, text, life: 60 });
}

function autoPilotShouldJumpGroundGap(movingLeft) {
  if (!player || !level || !player.onGround) return false;
  const footBottom = player.y + player.h;
  if (footBottom < GROUND_Y - 6) return false;
  if (movingLeft) {
    const onTile = Math.floor(player.x / TILE) * TILE;
    return level.groundSet.has(onTile) && !level.groundSet.has(onTile - TILE);
  }
  const tileX = Math.floor((player.x + player.w + 2) / TILE) * TILE;
  return level.groundSet.has(tileX - TILE) && !level.groundSet.has(tileX);
}

// ============================================================
// UPDATE
// ============================================================
function update(dt) {
  if (state.phase !== "playing") return;

  coinSpin += dt * 4;

  if (state.pipeWarpAnim) {
    updatePipeWarpAnim(dt);
    return;
  }

  const spMult = getLevelSpeedMult();
  const gMult  = getGravityMult();
  const k = dt * SIM_FPS;

  if (autoPilot) autoPilotJumpCooldown = Math.max(0, autoPilotJumpCooldown - dt);

  let autoPilotRetreating = false;
  const jumpVy0 = getPlayerJumpVy0();
  // --- Player input: ← → move, Space / ↑ / W jump, A fireball ---
  if (autoPilot) {
    autoPilotRetreating = autoPilotRetreatLeft > 0;
    if (autoPilotRetreating) {
      autoPilotRetreatLeft -= dt;
      player.facingRight = false;
      player.vx = -PLAYER_SPEED * spMult;
    } else {
      player.facingRight = true;
      player.vx = PLAYER_SPEED * spMult;
    }
    if (autoPilotJumpCooldown <= 0 && autoPilotShouldJumpGroundGap(autoPilotRetreating)) {
      player.vy = jumpVy0;
      player.onGround = false;
      autoPilotJumpCooldown = 0.35;
    }
  } else {
    if (keys["ArrowLeft"])    { player.vx = -PLAYER_SPEED * spMult; player.facingRight = false; }
    else if (keys["ArrowRight"]) { player.vx = PLAYER_SPEED * spMult;  player.facingRight = true;  }
    else player.vx *= Math.pow(0.75, k);

    if ((keys["Space"] || keys["ArrowUp"] || keys["KeyW"]) && player.onGround) {
      player.vy = jumpVy0;
      player.onGround = false;
    }
  }

  if (player.fireCooldown > 0) player.fireCooldown -= dt;
  const autoPilotShootEnemy = autoPilot && (
    level.enemies.some(e => {
      if (!e.alive || e.squished) return false;
      if (autoPilotRetreating) return e.x + e.w > player.x - 200 && e.x + e.w < player.x + player.w + 10;
      return e.x > player.x - 20 && e.x < player.x + 230;
    }) ||
    level.fish.some(fish => {
      if (!fish.alive || fish.squished || fish.y >= fish.baseY) return false;
      const fx = fish.x - fish.w / 2;
      if (autoPilotRetreating) return fx + fish.w > player.x - 200 && fx + fish.w < player.x + player.w + 10;
      return fx > player.x - 20 && fx < player.x + 230;
    })
  );
  if (player.powerStage >= 2 && player.fireCooldown <= 0 && (keys["KeyA"] || autoPilotShootEnemy)) {
    player.fireCooldown = FIRE_COOLDOWN_SEC;
    const dir = player.facingRight ? 1 : -1;
    fireballs.push({
      x: player.facingRight ? player.x + player.w - 4 : player.x - 6,
      y: player.y + 14,
      vx: dir * FIREBALL_SPEED * spMult,
      vy: 0,
      life: 96,
    });
  }

  // --- Physics (frame-rate independent; tuned at SIM_FPS) ---
  player.vy += GRAVITY * gMult * k;
  if (player.vy >  18) player.vy =  18;
  player.x += player.vx * k;
  player.y += player.vy * k;
  const ww = getWorldWidth();
  if (player.x < 0) player.x = 0;
  if (player.x > ww - player.w) player.x = ww - player.w;

  // --- Fall death (pit ignores i-frames unless autopilot test mode) ---
  if (player.y > CANVAS_H + 80) {
    if (autoPilot) {
      player.vy = 0;
      let gx = Math.floor(player.x / TILE) * TILE;
      if (!level.groundSet.has(gx)) {
        for (let s = 0; s < 400; s++) {
          gx -= TILE;
          if (gx < 0) { gx = 0; break; }
          if (level.groundSet.has(gx)) break;
        }
      }
      player.x = Math.max(0, gx);
      player.y = GROUND_Y - player.h;
      player.onGround = true;
    } else {
      damagePlayer(true); return;
    }
  }

  // --- Platform + pipe + ? blocks ---
  player.onGround = false;
  resolveVsBoxes(level.platforms);
  resolveVsBoxes(level.pipes);
  resolveQuestionBlocks();
  for (const qb of level.questionBlocks) {
    if (qb.bumpTimer > 0) qb.bumpTimer -= k;
  }

  if (autoPilot && player.onGround && autoPilotJumpCooldown <= 0 && Math.abs(player.vx) < 0.5) {
    player.vy = getPlayerJumpVy0();
    player.onGround = false;
    autoPilotJumpCooldown = 0.4;
  }

  // --- Track furthest-right for respawn (surface only) ---
  if (state.layer === "surface" && player.x > player.maxX) player.maxX = player.x;

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
      m.y -= 2 * k;
      m.emerge += k;
      continue;
    }
    m.vy += GRAVITY * gMult * k;
    m.x += m.vx * k;
    m.y += m.vy * k;
    m.onGround = false;
    resolveEntityVsBoxes(m, solidForMush);
    if (m.y > CANVAS_H + 80) {
      level.mushrooms.splice(i, 1);
      continue;
    }
    if (overlap(player.x, player.y, player.w, player.h, m.x, m.y, m.w, m.h)) {
      if (m.type === "power") {
        if (player.powerStage < 2) {
          player.powerStage++;
          player.greenShrink = false;
          syncPlayerHitbox(true);
          addPopup(m.x - camX + m.w / 2, m.y - 8, player.powerStage === 2 ? "FIRE!" : "SUPER!");
        } else {
          state.score += 1000;
          addPopup(m.x - camX + m.w / 2, m.y - 8, "+1000");
        }
      } else {
        player.greenShrink = true;
        syncPlayerHitbox(true);
        addPopup(m.x - camX + m.w / 2, m.y - 8, "SHRINK!");
      }
      level.mushrooms.splice(i, 1);
    }
  }

  // --- Coins (underground: wider hitbox; bonus coins count like surface — +1 coin, +100 score) ---
  const inBonusRoom = state.layer === "underground";
  const coinHitR = inBonusRoom ? 18 : 10;
  for (const c of level.coins) {
    if (c.r) continue;
    if (!overlap(player.x, player.y, player.w, player.h, c.x - coinHitR, c.y - coinHitR, coinHitR * 2, coinHitR * 2)) continue;
    c.r = true;
    state.coinsCollected++;
    state.score += 100;
    addPopup(c.x - camX, c.y, inBonusRoom || c.bonusOnly ? "\u2605 +100" : "+100");
    if (inBonusRoom || c.bonusOnly) state.bonusStars++;
  }

  // --- Enemies ---
  for (const e of level.enemies) {
    if (!e.alive) continue;
    if (e.squished) {
      e.squishTimer -= k;
      if (e.squishTimer <= 0) e.alive = false;
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
        const nx = e.x + e.vx * spMult * k;
        for (const pipe of level.pipes) {
          if (!overlap(e.x, e.y, e.w, e.h, pipe.x, pipe.y, pipe.w, pipe.h) &&
               overlap(nx,  e.y, e.w, e.h, pipe.x, pipe.y, pipe.w, pipe.h)) {
            e.vx = -e.vx;
            break;
          }
        }
      }
    }

    e.x += e.vx * spMult * k;
    if (e.x <= e.minX)          { e.x = e.minX;          e.vx =  Math.abs(e.vx); }
    if (e.x + e.w >= e.maxX)    { e.x = e.maxX - e.w;    e.vx = -Math.abs(e.vx); }

    if (!overlap(player.x, player.y, player.w, player.h, e.x, e.y, e.w, e.h)) continue;

    if (canStompGroundEnemy(player, e)) {
      e.squished    = true;
      e.squishTimer = 25;
      player.vy     = -9;
      state.enemiesDefeated++;
      state.score += 200;
      addPopup(e.x - camX, e.y - 20, "+200");
    } else {
      if (autoPilot || performance.now() < player.invincibleUntilMs) continue;
      damagePlayer();
      return;
    }
  }

  // --- Fish ---
  for (let i = level.fish.length - 1; i >= 0; i--) {
    const f = level.fish[i];
    if (!f.alive) { level.fish.splice(i, 1); continue; }
    if (f.squished) {
      f.squishTimer -= k;
      if (f.squishTimer <= 0) level.fish.splice(i, 1);
      continue;
    }

    if (!f.jumping) {
      f.jumpTimer -= k;
      if (f.jumpTimer <= 0) {
        const df  = f.x / getWorldWidth();                        // 0 at start, 1 at end
        const df3 = df * df * df;                         // cubic: stays slow until far
        f.vy = -(6 + 6 * df3);                            // -6 near start (high, slow) → -12 near end
        f.jumping = true;
      }
      continue;
    }

    f.vy += GRAVITY * 0.38 * gMult * k;   // reduced gravity → floaty, stays airborne longer
    f.y  += f.vy * k;

    if (f.y >= f.baseY) {              // back below water surface
      f.y = f.baseY;
      f.vy = 0;
      f.jumping = false;
      const df2  = f.x / getWorldWidth();
      const df23 = df2 * df2 * df2;   // cubic: long waits near start, short near end
      f.jumpTimer = Math.round(300 - 280 * df23) + (Math.floor(f.x / 7) % 35);
    }

    // Collide only while visible above water
    if (f.y < f.baseY) {
      if (!overlap(player.x, player.y, player.w, player.h, f.x - f.w / 2, f.y, f.w, f.h)) continue;
      if (canStompFish(player, f)) {
        f.alive = false;
        player.vy = -9;
        state.enemiesDefeated++;
        state.score += 200;
        addPopup(f.x - camX, f.y - 20, "+200");
      } else {
        if (autoPilot) continue;
        if (performance.now() < player.invincibleUntilMs) continue;
        damagePlayer();
        return;
      }
    }
  }

  // --- Fireballs ---
  for (let i = fireballs.length - 1; i >= 0; i--) {
    const fb = fireballs[i];
    fb.x += fb.vx * k;
    fb.life -= k;
    if (fb.life <= 0) {
      fireballs.splice(i, 1);
      continue;
    }
    let wall = false;
    for (const b of solidForMush) {
      if (overlap(fb.x, fb.y, 8, 8, b.x, b.y, b.w, b.h)) {
        wall = true;
        break;
      }
    }
    if (wall || fb.x < -20 || fb.x > getWorldWidth()) {
      fireballs.splice(i, 1);
      continue;
    }
    let hitSomething = false;
    for (const fish of level.fish) {
      if (!fish.alive || fish.squished || fish.y >= fish.baseY) continue;
      if (overlap(fb.x, fb.y, 8, 8, fish.x - fish.w / 2, fish.y, fish.w, fish.h)) {
        fish.squished = true;
        fish.squishTimer = 25;
        state.enemiesDefeated++;
        state.score += 200;
        addPopup(fish.x - camX, fish.y - 20, "+200");
        hitSomething = true;
        break;
      }
    }
    if (!hitSomething) {
      for (const e of level.enemies) {
        if (!e.alive || e.squished) continue;
        if (overlap(fb.x, fb.y, 8, 8, e.x, e.y, e.w, e.h)) {
          e.squished = true;
          e.squishTimer = 25;
          state.enemiesDefeated++;
          state.score += 200;
          addPopup(e.x - camX, e.y - 20, "+200");
          hitSomething = true;
          break;
        }
      }
    }
    if (hitSomething) fireballs.splice(i, 1);
  }

  // --- Flags: one per segment; 10th flag wins (~20k world) ---
  if (state.layer === "surface") {
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
  }

  // --- Camera ---
  {
    const wmax = getWorldWidth();
    camX = Math.max(0, Math.min(player.x - CANVAS_W / 3, wmax - CANVAS_W));
  }

  // --- Popups ---
  for (let i = state.popups.length - 1; i >= 0; i--) {
    state.popups[i].y  -= 0.8 * k;
    state.popups[i].life -= k;
    if (state.popups[i].life <= 0) state.popups.splice(i, 1);
  }

  if (autoPilot) {
    if (player.onGround && Math.abs(player.x - autoPilotLastX) < 0.45) autoPilotNoMoveAccum += dt;
    else autoPilotNoMoveAccum = 0;
    autoPilotLastX = player.x;
    if (player.onGround && autoPilotNoMoveAccum > 0.26 && autoPilotRetreatLeft <= 0) {
      autoPilotRetreatLeft = 0.62;
      autoPilotNoMoveAccum = 0;
    }
  }

  tryPipeWarpEnter();
  tryPipeWarpExit();
}

function damagePlayer(pitFall = false) {
  if (autoPilot) return;
  if (!pitFall && performance.now() < player.invincibleUntilMs) return;
  state.lives--;
  if (state.lives <= 0) {
    state.playTimeMs = Date.now() - state.runStartMs;
    state.phase = "gameover";
    submitScore();
  } else {
    if (state.layer === "underground") {
      player.x = 70;
      player.vx = 0;
      player.vy = 0;
      player.invincibleUntilMs = performance.now() + RESPAWN_INVINCIBLE_MS;
      player.powerStage = 0;
      player.greenShrink = false;
      player.w = PLAYER_SMALL_W;
      player.h = PLAYER_SMALL_H;
      player.y = GROUND_Y - player.h;
      player.fireCooldown = 0;
      fireballs         = [];
    } else {
      player.x         = Math.max(80, player.maxX - RESPAWN_SURFACE_BACK_TILES * TILE);
      player.vx        = 0;
      player.vy        = 0;
      player.invincibleUntilMs = performance.now() + RESPAWN_INVINCIBLE_MS;
      player.powerStage = 0;
      player.greenShrink = false;
      player.w = PLAYER_SMALL_W;
      player.h = PLAYER_SMALL_H;
      player.y = GROUND_Y - player.h;
      player.fireCooldown = 0;
      fireballs         = [];
    }
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

function getSeasonalParallaxHillColor(themeHill, seasonIndex, blend) {
  const springOrange = "#ff7043";
  const winterSnow = "#eceff1";
  if (seasonIndex === 0) return lerpColor(springOrange, themeHill, blend);
  if (seasonIndex === 1) return lerpColor(themeHill, springOrange, (1 - blend) * 0.38);
  if (seasonIndex === 2) return lerpColor(themeHill, winterSnow, blend * 0.88);
  if (seasonIndex === 3) return lerpColor(winterSnow, themeHill, blend);
  return themeHill;
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

// 0 spring, 1 summer, 2 fall, 3 winter — advances every 10 seconds
function getSeasonProgress() {
  const seasonCycleSec = SEASON_DURATION_SEC * 4;
  const elapsedSec = state.runStartMs > 0
    ? (Date.now() - state.runStartMs) / 1000
    : Date.now() / 1000;
  const seg = (elapsedSec / SEASON_DURATION_SEC) % 4;
  const index = Math.floor(seg);
  const blend = seg - index;
  const t = (elapsedSec % seasonCycleSec) / seasonCycleSec;
  return { index, blend, t };
}

const STAGE_THEMES = [
  { name: "Classic Plains", top: "#6ec6ff", mid: "#a5d6ff", bot: "#d7f0ff", cloud: "#ffffff", hill: "#66bb6a" },
  { name: "Jungle", top: "#2e7d32", mid: "#43a047", bot: "#81c784", cloud: "#dcedc8", hill: "#2e7d32" },
  { name: "Egypt Desert", top: "#ffca70", mid: "#ffb347", bot: "#ffe0a8", cloud: "#fff3cd", hill: "#c49a5a" },
  { name: "Frozen World", top: "#b3e5fc", mid: "#81d4fa", bot: "#e1f5fe", cloud: "#f5fbff", hill: "#90caf9" },
  { name: "Underwater", top: "#01579b", mid: "#0277bd", bot: "#4fc3f7", cloud: "#b3e5fc", hill: "#0288d1" },
  { name: "Sunset Canyon", top: "#ff8a65", mid: "#ff7043", bot: "#ffccbc", cloud: "#ffe0b2", hill: "#8d6e63" },
  { name: "Neon City", top: "#1a237e", mid: "#283593", bot: "#3949ab", cloud: "#c5cae9", hill: "#303f9f" },
  { name: "Volcanic", top: "#4e342e", mid: "#5d4037", bot: "#8d6e63", cloud: "#d7ccc8", hill: "#3e2723" },
  { name: "Sky Realm", top: "#90caf9", mid: "#bbdefb", bot: "#e3f2fd", cloud: "#ffffff", hill: "#64b5f6" },
  { name: "Cosmic Night", top: "#0b1026", mid: "#1a237e", bot: "#283593", cloud: "#9fa8da", hill: "#1c2b5a" },
];

// Fade in/out at start/end of each season so effects never overlap between seasons.
function seasonParticleEdgeAlpha(blend) {
  const fin = 0.14;
  const fout = 0.14;
  let a = 1;
  if (blend < fin) a = blend / fin;
  if (blend > 1 - fout) a = Math.min(a, (1 - blend) / fout);
  return Math.max(0, Math.min(1, a));
}

// Sun, petals, maple leaves, snow — exactly one season at a time (no cross-fade overlap).
function drawSeasonalParticles(seasonIndex, blend) {
  const edge = seasonParticleEdgeAlpha(blend);

  // Summer sun — only summer segment
  if (seasonIndex === 1) {
    const sunA = edge;
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

  // Spring: drifting sakura petals — only spring
  if (seasonIndex === 0) {
    ctx.globalAlpha = edge;
    for (let i = 0; i < 78; i++) {
      const flow = coinSpin * 26 + camX * 0.2;
      const px = ((i * 67 + camX * 0.45 + flow) % (CANVAS_W + 100)) - 35;
      const py = 15 + ((i * 41 + coinSpin * 30 + camX * 0.2) % (CANVAS_H - 95));
      ctx.fillStyle = "rgba(248, 187, 208, 0.72)";
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(coinSpin * 0.38 + i * 0.16);
      ctx.beginPath();
      ctx.ellipse(0, 0, 5.5, 3.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(244, 143, 177, 0.45)";
      ctx.beginPath();
      ctx.ellipse(-2, 1, 2.5, 1.6, 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // Fall: flying maple leaves — only fall
  if (seasonIndex === 2) {
    ctx.globalAlpha = edge;
    for (let i = 0; i < 56; i++) {
      const drift = Math.sin(coinSpin * 0.85 + i * 0.31) * 18;
      const px = ((i * 89 - camX * 0.58 + coinSpin * 22) % (CANVAS_W + 90)) - 45;
      const py = 25 + ((i * 73 + coinSpin * 34 + camX * 0.3) % (CANVAS_H - 85));
      const wobble = Math.sin(coinSpin * 1.15 + i) * 0.55;
      ctx.save();
      ctx.translate(px + drift, py);
      ctx.rotate(wobble + i * 0.68);
      ctx.fillStyle = i % 3 === 0 ? "#b71c1c" : (i % 3 === 1 ? "#e65100" : "#ff9800");
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(2.5, -1);
      ctx.lineTo(8, 0.5);
      ctx.lineTo(2.5, 2.5);
      ctx.lineTo(2, 8);
      ctx.lineTo(0, 4.5);
      ctx.lineTo(-2, 8);
      ctx.lineTo(-2.5, 2.5);
      ctx.lineTo(-8, 0.5);
      ctx.lineTo(-2.5, -1);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(121, 85, 72, 0.45)";
      ctx.lineWidth = 0.6;
      ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // Winter: heavy snow — only winter
  if (seasonIndex === 3) {
    ctx.globalAlpha = edge;
    for (let i = 0; i < 140; i++) {
      const px = ((i * 47 + camX * 0.72 + coinSpin * 40) % (CANVAS_W + 45)) - 18;
      const py = ((i * 61 + coinSpin * 58 + camX * 0.14) % (CANVAS_H + 55)) - 28;
      const s = 1.1 + (i % 6) * 0.5;
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.fillRect(px, py, s * 2.2, s * 2.2);
      ctx.fillRect(px + s * 0.6, py + s * 1.4, s * 1.1, s * 1.1);
    }
    for (let i = 0; i < 45; i++) {
      const px = ((i * 59 + camX * 0.55 + coinSpin * 28) % (CANVAS_W + 35)) - 12;
      const py = ((i * 67 + coinSpin * 44) % (CANVAS_H + 45)) - 22;
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.beginPath();
      ctx.arc(px, py, 3 + (i % 4), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

// Draws seasonal trees at ground level behind all game elements.
// Parallaxed at 0.55× camera speed (between hills and platforms).
function drawGroundTrees(seasonIndex, blend) {
  for (let i = 0; i < 10; i++) {
    const rawX = 60 + i * 210;
    const sx = ((rawX - camX * 0.55 + (CANVAS_W + 260) * 20) % (CANVAS_W + 260)) - 130;
    if (sx < -130 || sx > CANVAS_W + 130) continue;

    const treeH  = 60 + (i % 3) * 20;
    const canopyR = 24 + (i % 3) * 7;
    const trunkW  = 7 + (i % 2) * 4;
    const baseY   = GROUND_Y;
    const cy      = baseY - treeH;

    // Trunk
    ctx.fillStyle = "#5d4037";
    ctx.fillRect(sx - trunkW / 2, baseY - treeH * 0.62, trunkW, treeH * 0.62);

    if (seasonIndex === 0) {
      // Spring — sakura: soft pink blossom cloud
      ctx.fillStyle = "rgba(248,187,208,0.9)";
      ctx.beginPath(); ctx.arc(sx, cy, canopyR, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(244,143,177,0.55)";
      ctx.beginPath(); ctx.arc(sx - canopyR * 0.38, cy + 5, canopyR * 0.62, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(sx + canopyR * 0.38, cy + 5, canopyR * 0.62, 0, Math.PI * 2); ctx.fill();
    } else if (seasonIndex === 1) {
      // Summer — full green
      ctx.fillStyle = "#2e7d32";
      ctx.beginPath(); ctx.arc(sx, cy, canopyR, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#43a047";
      ctx.beginPath(); ctx.arc(sx - canopyR * 0.3, cy + 4, canopyR * 0.6, 0, Math.PI * 2); ctx.fill();
    } else if (seasonIndex === 2) {
      // Fall — maple: orange / deep red
      const mapCol = i % 3 === 0 ? "#e65100" : i % 3 === 1 ? "#bf360c" : "#ff6d00";
      ctx.fillStyle = mapCol;
      ctx.beginPath(); ctx.arc(sx, cy, canopyR, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255,152,0,0.5)";
      ctx.beginPath(); ctx.arc(sx + canopyR * 0.3, cy - 4, canopyR * 0.55, 0, Math.PI * 2); ctx.fill();
    } else {
      // Winter — bare branches with snow caps
      ctx.strokeStyle = "#5d4037"; ctx.lineWidth = 2;
      for (let b = 0; b < 5; b++) {
        const ang = -Math.PI / 2 + (b - 2) * 0.42;
        ctx.beginPath();
        ctx.moveTo(sx, baseY - treeH * 0.62);
        ctx.lineTo(sx + Math.cos(ang) * canopyR, cy + Math.sin(ang) * canopyR * 0.7);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(236,239,241,0.88)";
      for (let b = 0; b < 5; b++) {
        const ang = -Math.PI / 2 + (b - 2) * 0.42;
        const bx2 = sx + Math.cos(ang) * canopyR;
        const by2 = cy + Math.sin(ang) * canopyR * 0.7;
        ctx.beginPath(); ctx.ellipse(bx2, by2, 9, 5, ang, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
}

// Snow cap on top of every visible ground/brick tile — drawn after platforms.
function drawWinterGroundSnow() {
  if (state.layer === "underground") return;
  const { index, blend } = getSeasonProgress();
  if (index !== 3 && !(index === 2 && blend > 0.7)) return;
  const alpha = index === 3 ? 0.82 : (blend - 0.7) / 0.3 * 0.82;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "#eceff1";
  for (const p of level.platforms) {
    const sx = p.x - camX;
    if (sx + p.w < 0 || sx > CANVAS_W) continue;
    ctx.fillRect(sx, p.y, p.w, p.type === "ground" ? 6 : 4);
  }
  ctx.globalAlpha = 1;
}

function getStageThemeIndex() {
  return Math.min(STAGE_THEMES.length - 1, Math.max(0, state.flagsPassed));
}

// Parallax midground shapes (purely decorative). Egypt / stage 3 = cubist Picasso-inspired facets.
function drawPicassoCubistDesertMidground() {
  const p = camX * 0.26;
  ctx.save();
  ctx.globalAlpha = 0.88;
  const palette = ["#1a237e", "#3949ab", "#c62828", "#e65100", "#f9a825", "#fdd835", "#4a148c", "#00695c"];
  for (let k = 0; k < 11; k++) {
    const ox = ((k * 210 - p + 3200) % 3800) - 280;
    const oy = 35 + (k % 4) * 28;
    const rot = 0.15 + (k % 5) * 0.12;
    ctx.fillStyle = palette[k % palette.length];
    ctx.beginPath();
    ctx.moveTo(ox + Math.cos(rot) * 20, oy + Math.sin(rot) * 10);
    ctx.lineTo(ox + 95 + k * 3, oy - 25 + (k % 2) * 15);
    ctx.lineTo(ox + 130, oy + 95);
    ctx.lineTo(ox + 15, oy + 110);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.28)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = "#ffcc80";
  ctx.beginPath();
  ctx.ellipse((180 - p * 0.4 % 200 + CANVAS_W) % CANVAS_W + 40, 108, 22, 28, 0.45, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#3e2723";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.fillStyle = "#212121";
  ctx.beginPath();
  ctx.ellipse((195 - p * 0.35 % 180 + CANVAS_W) % CANVAS_W + 50, 102, 4, 5, 0.3, 0, Math.PI * 2);
  ctx.ellipse((215 - p * 0.35 % 180 + CANVAS_W) % CANVAS_W + 62, 100, 3, 4, -0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#5d4037";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo((200 - p * 0.35 % 180 + CANVAS_W) % CANVAS_W + 55, 125);
  ctx.quadraticCurveTo((230 - p * 0.35 % 180 + CANVAS_W) % CANVAS_W + 80, 118, (260 - p * 0.35 % 180 + CANVAS_W) % CANVAS_W + 70, 135);
  ctx.stroke();
  ctx.fillStyle = "#c62828";
  ctx.beginPath();
  ctx.moveTo((380 - p * 0.5 % 300 + CANVAS_W) % CANVAS_W, 200);
  ctx.lineTo((420 - p * 0.5 % 300 + CANVAS_W) % CANVAS_W, 165);
  ctx.lineTo((450 - p * 0.5 % 300 + CANVAS_W) % CANVAS_W, 210);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// Stages 3–10: extra Picasso-inspired abstract layers (different “period” per stage). Decorative only.
function drawPicassoAbstractSkyLayer(ti) {
  if (ti < 2) return;
  const p = camX * 0.19;
  const q = camX * 0.11;
  ctx.save();
  ctx.globalAlpha = 0.36;
  switch (ti) {
    case 2: {
      const pal = ["#283593", "#c62828", "#f9a825", "#004d40", "#6a1b9a"];
      for (let k = 0; k < 16; k++) {
        const ox = ((k * 165 - p + 4100) % 4400) - 320;
        const oy = 20 + (k % 5) * 36;
        ctx.fillStyle = pal[k % pal.length];
        ctx.beginPath();
        ctx.moveTo(ox, oy + 40);
        ctx.lineTo(ox + 70 + (k % 3) * 12, oy - 8);
        ctx.lineTo(ox + 110, oy + 90);
        ctx.lineTo(ox - 15, oy + 75);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.22)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      break;
    }
    case 3: {
      ctx.globalAlpha = 0.4;
      for (let k = 0; k < 14; k++) {
        const ox = ((k * 175 - q + 3600) % 4000) - 280;
        const oy = 45 + (k % 4) * 22;
        ctx.fillStyle = k % 2 === 0 ? "rgba(100,181,246,0.55)" : "rgba(227,242,253,0.45)";
        ctx.beginPath();
        ctx.moveTo(ox, oy + 60);
        ctx.lineTo(ox + 45, oy);
        ctx.lineTo(ox + 95, oy + 35);
        ctx.lineTo(ox + 40, oy + 85);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case 4: {
      for (let k = 0; k < 12; k++) {
        const ox = ((k * 190 - p + 3500) % 3900) - 260;
        const oy = 60 + (k % 3) * 30;
        ctx.fillStyle = k % 2 === 0 ? "rgba(0,151,167,0.5)" : "rgba(38,166,154,0.4)";
        ctx.beginPath();
        ctx.arc(ox + 40, oy + 30, 38, 0.2, Math.PI + 0.6);
        ctx.lineTo(ox + 95, oy + 70);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case 5: {
      for (let k = 0; k < 13; k++) {
        const ox = ((k * 155 - q + 3800) % 4100) - 300;
        const oy = 30 + (k % 4) * 28;
        ctx.fillStyle = k % 3 === 0 ? "rgba(255,112,67,0.55)" : (k % 3 === 1 ? "rgba(255,213,79,0.45)" : "rgba(216,67,21,0.4)");
        ctx.beginPath();
        ctx.moveTo(ox, oy + 80);
        ctx.lineTo(ox + 55, oy);
        ctx.lineTo(ox + 100, oy + 50);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case 6: {
      ctx.globalAlpha = 0.45;
      for (let k = 0; k < 18; k++) {
        const ox = ((k * 98 - p + 3200) % 3600) - 200;
        const oy = 25 + (k % 6) * 18;
        ctx.fillStyle = k % 2 === 0 ? "rgba(0,229,255,0.35)" : "rgba(255,64,129,0.32)";
        ctx.fillRect(ox, oy, 32 + (k % 4) * 8, 22 + (k % 3) * 6);
        ctx.strokeStyle = "rgba(255,255,255,0.15)";
        ctx.strokeRect(ox, oy, 32 + (k % 4) * 8, 22 + (k % 3) * 6);
      }
      break;
    }
    case 7: {
      for (let k = 0; k < 15; k++) {
        const ox = ((k * 142 - q + 3400) % 3800) - 250;
        const oy = 40 + (k % 5) * 24;
        ctx.fillStyle = k % 2 === 0 ? "rgba(93,64,55,0.55)" : "rgba(255,87,34,0.4)";
        ctx.beginPath();
        ctx.moveTo(ox + 20, oy);
        ctx.lineTo(ox + 90, oy + 20);
        ctx.lineTo(ox + 70, oy + 95);
        ctx.lineTo(ox, oy + 70);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case 8: {
      ctx.globalAlpha = 0.32;
      for (let k = 0; k < 11; k++) {
        const ox = ((k * 210 - p + 4000) % 4200) - 300;
        const oy = 55 + (k % 3) * 40;
        ctx.fillStyle = "rgba(187,222,251,0.5)";
        ctx.beginPath();
        ctx.ellipse(ox + 50, oy + 40, 55, 28, 0.35 + k * 0.08, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(100,181,246,0.35)";
        ctx.stroke();
      }
      break;
    }
    case 9: {
      ctx.globalAlpha = 0.4;
      for (let k = 0; k < 20; k++) {
        const ox = ((k * 120 - q + 3000) % 3400) - 180;
        const oy = 25 + (k % 7) * 20;
        const hue = (k * 47 + Math.floor(camX * 0.02)) % 360;
        ctx.fillStyle = `hsla(${hue}, 52%, 48%, 0.38)`;
        ctx.beginPath();
        ctx.moveTo(ox, oy + 50);
        ctx.lineTo(ox + 35, oy);
        ctx.lineTo(ox + 75, oy + 45);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    default:
      break;
  }
  ctx.restore();
}

// Ground-line silhouettes when classic trees are off (stage 3+). Parallax only — no collision.
function drawThemedGroundSilhouettes(themeIndex) {
  const par = camX * 0.52;
  const baseY = GROUND_Y;

  if (themeIndex === 2) {
    for (let i = 0; i < 9; i++) {
      const sx = ((i * 230 - par + 2600) % 3000) - 150;
      if (sx < -80 || sx > CANVAS_W + 80) continue;
      ctx.fillStyle = "#4e342e";
      ctx.fillRect(sx - 3, baseY - 55, 7, 55);
      ctx.fillStyle = "#33691e";
      ctx.beginPath();
      ctx.arc(sx, baseY - 58, 28, Math.PI, 0);
      ctx.fill();
      ctx.fillStyle = "#1b5e20";
      ctx.beginPath();
      ctx.ellipse(sx - 12, baseY - 52, 16, 10, -0.4, 0, Math.PI * 2);
      ctx.ellipse(sx + 14, baseY - 50, 18, 11, 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (themeIndex === 3) {
    for (let i = 0; i < 10; i++) {
      const sx = ((i * 200 - par + 2400) % 2800) - 120;
      if (sx < -60 || sx > CANVAS_W + 60) continue;
      const h = 70 + (i % 4) * 22;
      ctx.fillStyle = "#37474f";
      ctx.beginPath();
      ctx.moveTo(sx, baseY);
      ctx.lineTo(sx + 35, baseY - h);
      ctx.lineTo(sx + 70, baseY);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(236,239,241,0.65)";
      ctx.beginPath();
      ctx.moveTo(sx + 22, baseY - h);
      ctx.lineTo(sx + 35, baseY - h - 18);
      ctx.lineTo(sx + 48, baseY - h);
      ctx.closePath();
      ctx.fill();
    }
  } else if (themeIndex === 4) {
    ctx.strokeStyle = "rgba(46,125,50,0.55)";
    ctx.lineWidth = 5;
    for (let i = 0; i < 14; i++) {
      const sx = ((i * 95 - par * 1.1 + 1800) % 2200) - 100;
      const ph = i * 0.7;
      ctx.beginPath();
      ctx.moveTo(sx, baseY);
      ctx.bezierCurveTo(sx + 12 + Math.sin(coinSpin + ph) * 8, baseY - 50, sx - 8, baseY - 100, sx + 5, baseY - 140);
      ctx.stroke();
    }
  } else if (themeIndex === 5) {
    for (let i = 0; i < 6; i++) {
      const sx = ((i * 320 - par * 0.9 + 2000) % 2600) - 140;
      const h = 90 + (i % 3) * 35;
      ctx.fillStyle = i % 2 === 0 ? "#bf360c" : "#d84315";
      ctx.beginPath();
      ctx.moveTo(sx, baseY);
      ctx.lineTo(sx + 40, baseY - h * 0.45);
      ctx.lineTo(sx + 85, baseY - h);
      ctx.lineTo(sx + 120, baseY - h * 0.5);
      ctx.lineTo(sx + 160, baseY);
      ctx.closePath();
      ctx.fill();
    }
  } else if (themeIndex === 6) {
    for (let i = 0; i < 10; i++) {
      const sx = ((i * 150 - par + 1900) % 2400) - 100;
      const h = 55 + (i % 5) * 18;
      ctx.fillStyle = "#1a237e";
      ctx.fillRect(sx, baseY - h, 14, h);
      ctx.fillStyle = i % 2 === 0 ? "#00e5ff" : "#ff4081";
      ctx.fillRect(sx + 2, baseY - h + 8, 10, 6);
    }
  } else if (themeIndex === 7) {
    for (let i = 0; i < 8; i++) {
      const sx = ((i * 260 - par + 2100) % 2500) - 130;
      ctx.fillStyle = "#3e2723";
      ctx.beginPath();
      ctx.moveTo(sx, baseY);
      ctx.lineTo(sx + 50, baseY - 45);
      ctx.lineTo(sx + 100, baseY);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(255,87,34,0.45)";
      ctx.beginPath();
      ctx.arc(sx + 50, baseY - 38, 12, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (themeIndex === 8) {
    for (let i = 0; i < 7; i++) {
      const sx = ((i * 280 - par * 0.75 + 2200) % 2700) - 150;
      const h = 65 + (i % 3) * 25;
      ctx.fillStyle = "rgba(227,242,253,0.55)";
      ctx.fillRect(sx, baseY - h, 40, h);
      ctx.strokeStyle = "rgba(100,181,246,0.5)";
      ctx.lineWidth = 2;
      ctx.strokeRect(sx, baseY - h, 40, h);
    }
  } else if (themeIndex === 9) {
    for (let i = 0; i < 12; i++) {
      const sx = ((i * 140 - par + 2000) % 2600) - 100;
      const t = coinSpin * 0.15 + i;
      ctx.save();
      ctx.translate(sx, baseY - 40);
      ctx.rotate(t * 0.02);
      ctx.fillStyle = `hsla(${(i * 30) % 360}, 45%, 55%, 0.45)`;
      ctx.beginPath();
      ctx.moveTo(0, 40);
      ctx.lineTo(15, -20);
      ctx.lineTo(-12, -15);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }
}

// Extra midground lines for early stages (behind trees).
function drawStageMidgroundExtras(themeIndex) {
  const p = camX * 0.35;
  if (themeIndex === 0) {
    ctx.fillStyle = "rgba(129,199,132,0.35)";
    for (let i = 0; i < 5; i++) {
      const hx = ((i * 420 - p + 2000) % 2400) - 200;
      ctx.beginPath();
      ctx.arc(hx, GROUND_Y + 20, 80 + i * 15, Math.PI, 0);
      ctx.fill();
    }
  } else if (themeIndex === 1) {
    ctx.fillStyle = "rgba(46,125,50,0.25)";
    for (let i = 0; i < 6; i++) {
      const x = ((i * 300 - p + 1800) % 2600) - 150;
      ctx.beginPath();
      ctx.ellipse(x, 120 + i * 8, 90, 35, 0.2 + i * 0.05, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawThemeDecor(themeIndex) {
  if (themeIndex === 1) {
    // Jungle vines
    ctx.strokeStyle = "rgba(27,94,32,0.8)";
    ctx.lineWidth = 4;
    for (let i = 0; i < 6; i++) {
      const x = ((i * 170 - camX * 0.3 + 1800) % (CANVAS_W + 120)) - 60;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.bezierCurveTo(x + 20, 120, x - 18, 240, x + 12, 340);
      ctx.stroke();
    }
  } else if (themeIndex === 2) {
    drawPicassoCubistDesertMidground();
  } else if (themeIndex === 3) {
    // Frozen mountains
    for (let i = 0; i < 5; i++) {
      const bx = ((i * 260 - camX * 0.5 + 2000) % (CANVAS_W + 200)) - 100;
      const by = GROUND_Y - 20;
      ctx.fillStyle = "#90a4ae";
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + 70, by - 120);
      ctx.lineTo(bx + 140, by);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#eceff1";
      ctx.beginPath();
      ctx.moveTo(bx + 48, by - 40);
      ctx.lineTo(bx + 70, by - 120);
      ctx.lineTo(bx + 92, by - 40);
      ctx.closePath();
      ctx.fill();
    }
  } else if (themeIndex === 4) {
    // Underwater bubbles and coral
    ctx.fillStyle = "rgba(179,229,252,0.35)";
    for (let i = 0; i < 36; i++) {
      const x = ((i * 61 + camX * 0.4 + coinSpin * 24) % (CANVAS_W + 80)) - 20;
      const y = ((i * 79 - coinSpin * 36) % (CANVAS_H + 120)) - 40;
      const r = 2 + (i % 4);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#ff7043";
    for (let i = 0; i < 7; i++) {
      const x = ((i * 140 - camX * 0.45 + 1600) % (CANVAS_W + 120)) - 40;
      const h = 18 + (i % 3) * 14;
      ctx.fillRect(x, GROUND_Y - h, 8, h);
      ctx.fillRect(x + 10, GROUND_Y - h * 0.8, 8, h * 0.8);
    }
  } else if (themeIndex === 6) {
    // Neon city blocks
    for (let i = 0; i < 8; i++) {
      const x = ((i * 125 - camX * 0.55 + 2000) % (CANVAS_W + 140)) - 60;
      const h = 70 + (i % 4) * 28;
      ctx.fillStyle = "#1c2b6b";
      ctx.fillRect(x, GROUND_Y - h, 60, h);
      ctx.fillStyle = i % 2 === 0 ? "#00e5ff" : "#ff4081";
      for (let w = 0; w < 4; w++) {
        for (let r = 0; r < 4; r++) {
          ctx.fillRect(x + 8 + w * 12, GROUND_Y - h + 8 + r * 14, 6, 8);
        }
      }
    }
  } else if (themeIndex === 7) {
    // Volcanic embers
    ctx.fillStyle = "rgba(255,87,34,0.7)";
    for (let i = 0; i < 42; i++) {
      const x = ((i * 53 - camX * 0.3 + coinSpin * 16) % (CANVAS_W + 70)) - 20;
      const y = ((i * 67 - coinSpin * 20) % (CANVAS_H + 100)) - 30;
      ctx.fillRect(x, y, 2, 2);
    }
  } else if (themeIndex === 5) {
    const p = camX * 0.2;
    ctx.fillStyle = "rgba(255,183,77,0.35)";
    ctx.beginPath();
    ctx.arc(((400 - p) % (CANVAS_W + 80)) - 20, 55, 48, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,213,79,0.2)";
    ctx.lineWidth = 4;
    for (let r = 1; r <= 4; r++) {
      ctx.beginPath();
      ctx.arc(((400 - p) % (CANVAS_W + 80)) + 20, 55, 20 + r * 22, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (themeIndex === 8) {
    const p = camX * 0.18;
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    for (let i = 0; i < 5; i++) {
      const cx = ((i * 220 - p + 1600) % 2000) - 100;
      const cy = 60 + i * 25;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 55, 22, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (themeIndex === 9) {
    // Cosmic stars
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    for (let i = 0; i < 90; i++) {
      const x = (i * 97) % CANVAS_W;
      const y = (i * 43 + Math.floor(camX * 0.04)) % (CANVAS_H - 80);
      ctx.fillRect(x, y, 2, 2);
    }
  }
}

function drawBackground() {
  if (state.layer === "underground") {
    const bs = (level && level.bonusSegment != null) ? level.bonusSegment % 10 : 0;
    const UG_PAL = [
      ["#1a237e", "#0d1642", "#030508"],
      ["#311b92", "#4527a0", "#12051a"],
      ["#004d40", "#00695c", "#011910"],
      ["#3e2723", "#5d4037", "#1a1008"],
      ["#01579b", "#0277bd", "#001a2e"],
      ["#4a148c", "#6a1b9a", "#140a18"],
      ["#1b5e20", "#2e7d32", "#051005"],
      ["#bf360c", "#e65100", "#210800"],
      ["#263238", "#37474f", "#0a0e10"],
      ["#0d1b2a", "#1b263b", "#020408"],
    ];
    const pal = UG_PAL[bs];
    const g = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
    g.addColorStop(0, pal[0]);
    g.addColorStop(0.5, pal[1]);
    g.addColorStop(1, pal[2]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = "rgba(255,255,255,0.035)";
    for (let i = 0; i < 28; i++) {
      for (let j = 0; j < 18; j++) {
        ctx.fillRect(i * 38 + (j % 4) * 5, j * 34, 30, 3);
      }
    }
    return;
  }
  const stageThemeIndex = getStageThemeIndex();
  const season = getSeasonProgress();
  const theme = STAGE_THEMES[stageThemeIndex];
  const g = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  g.addColorStop(0, theme.top);
  g.addColorStop(0.45, theme.mid);
  g.addColorStop(1, theme.bot);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Parallax clouds
  ctx.fillStyle = theme.cloud;
  const clouds = [[120,70,50],[290,50,40],[480,80,55],[650,45,42],[780,65,38]];
  for (const [bx, by, r] of clouds) {
    const cx = ((bx - camX * 0.25 % (CANVAS_W + 200) + CANVAS_W + 200) % (CANVAS_W + 200)) - 100;
    ctx.beginPath();
    ctx.arc(cx,      by,     r,      0, Math.PI * 2);
    ctx.arc(cx + r,  by - 12, r + 6, 0, Math.PI * 2);
    ctx.arc(cx + r * 2.2, by, r,    0, Math.PI * 2);
    ctx.fill();
  }

  if (stageThemeIndex >= 2) {
    drawPicassoAbstractSkyLayer(stageThemeIndex);
  }

  // Parallax hills (seasonal: spring orange, winter snow)
  const hillCol = getSeasonalParallaxHillColor(theme.hill, season.index, season.blend);
  const winterHill = season.index === 3 || (season.index === 2 && season.blend > 0.78);
  for (let h = 0; h < 8; h++) {
    const hx = ((h * 700 - camX * 0.45 + 5600) % 5600) - 200;
    const hr  = 100 + (h % 3) * 35;
    ctx.fillStyle = hillCol;
    ctx.beginPath();
    ctx.arc(hx, CANVAS_H - 30, hr, Math.PI, 0);
    ctx.fill();
    if (winterHill) {
      const peakY = CANVAS_H - 30 - hr;
      const capA = Math.min(1, season.index === 3 ? 0.88 : (season.blend - 0.78) / 0.22 * 0.88);
      ctx.fillStyle = `rgba(255,255,255,${capA})`;
      ctx.beginPath();
      ctx.arc(hx, peakY + hr * 0.28, hr * 0.42, Math.PI, 0);
      ctx.fill();
      ctx.fillStyle = `rgba(250,250,252,${capA * 0.5})`;
      ctx.beginPath();
      ctx.arc(hx - hr * 0.24, peakY + hr * 0.18, hr * 0.2, Math.PI, 0);
      ctx.arc(hx + hr * 0.22, peakY + hr * 0.16, hr * 0.19, Math.PI, 0);
      ctx.fill();
    }
  }

  drawStageMidgroundExtras(stageThemeIndex);
  if (stageThemeIndex <= 1) {
    drawGroundTrees(season.index, season.blend);
  } else {
    drawThemedGroundSilhouettes(stageThemeIndex);
  }
  drawThemeDecor(stageThemeIndex);
  drawSeasonalParticles(season.index, season.blend);
}

function drawWater() {
  if (state.layer === "underground") return;
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
  ctx.fillStyle = m.type === "green" ? "#2e7d32" : "#c62828";
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

function drawFish(f) {
  if (!f.alive) return;
  const sx = f.x - camX;
  if (sx < -40 || sx > CANVAS_W + 40) return;

  const drawY = f.squished ? f.baseY - f.h * 0.35 : f.y;
  if (!f.squished && f.y >= f.baseY) return;

  const cx = sx;
  const cy = drawY + f.h * 0.5;
  const r  = f.squished ? f.w * 0.46 * 0.55 : f.w * 0.46;

  // Pufferfish body
  ctx.fillStyle = "#c8e6c9";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // Belly (lighter)
  ctx.fillStyle = "#e8f5e9";
  ctx.beginPath();
  ctx.ellipse(cx, cy + r * 0.2, r * 0.55, r * 0.45, 0, 0, Math.PI * 2);
  ctx.fill();

  // Spikes (10 around the body)
  ctx.fillStyle = "#558b2f";
  const N = 10;
  for (let s = 0; s < N; s++) {
    const a = (s / N) * Math.PI * 2;
    const a1 = a - 0.18, a2 = a + 0.18;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r);
    ctx.lineTo(cx + Math.cos(a)  * (r + 7), cy + Math.sin(a)  * (r + 7));
    ctx.lineTo(cx + Math.cos(a2) * r, cy + Math.sin(a2) * r);
    ctx.closePath();
    ctx.fill();
  }

  // Dark spots
  ctx.fillStyle = "#33691e";
  ctx.beginPath(); ctx.arc(cx - r * 0.28, cy - r * 0.18, 3,   0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + r * 0.1,  cy + r * 0.28, 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + r * 0.38, cy - r * 0.08, 2,   0, Math.PI * 2); ctx.fill();

  // Eye
  ctx.fillStyle = "#fff";
  ctx.beginPath(); ctx.arc(cx + r * 0.48, cy - r * 0.08, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#000";
  ctx.beginPath(); ctx.arc(cx + r * 0.48 + 0.6, cy - r * 0.08, 2.8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.beginPath(); ctx.arc(cx + r * 0.48 + 1.4, cy - r * 0.08 - 1.2, 1, 0, Math.PI * 2); ctx.fill();

  // Tiny mouth
  ctx.strokeStyle = "#1b5e20";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx + r * 0.8, cy + r * 0.12, 3, 0.2, Math.PI - 0.2);
  ctx.stroke();
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
  if (pipe.warpDown || pipe.warpUp) {
    ctx.fillStyle = "#6a1c1c";
    ctx.fillRect(sx + 4, pipe.y + TILE, pipe.w - 8, pipe.h - TILE);
    ctx.fillStyle = "#4a0f0f";
    ctx.fillRect(sx, pipe.y, pipe.w, TILE);
    ctx.fillStyle = "#300808";
    ctx.fillRect(sx + 4, pipe.y, 8, TILE);
    ctx.fillRect(sx + 4, pipe.y + TILE, 5, pipe.h - TILE);
    return;
  }
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
  ctx.fillStyle = c.bonusOnly ? "#b3e5fc" : "#ffd700"; ctx.fill();
  ctx.strokeStyle = "#e65100"; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = c.bonusOnly ? "#0277bd" : "#e65100"; ctx.font = "bold 9px Arial";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(c.bonusOnly ? "\u2605" : "$", 0, 1);
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

/**
 * Classic vector Mario (pre–pixel-sprite style): brown shoes, blue overalls,
 * red shirt & cap, tan face, Yale “Y”. Fire tier: white shirt. Layout is
 * scaled from the original 28×36 reference to current player.w / player.h.
 */
function drawPlayerClassicVector(ox) {
  const w = player.w;
  const h = player.h;
  const sx = (x) => ox + (x / 28) * w;
  const sy = (y) => player.y + (y / 36) * h;
  const rw = (dw) => Math.max(1, (dw / 28) * w);
  const rh = (dh) => Math.max(1, (dh / 36) * h);
  const shirt = player.powerStage >= 2 ? "#fafafa" : "#c62828";

  ctx.fillStyle = "#3e2723";
  ctx.fillRect(sx(1), sy(28), rw(10), rh(8));
  ctx.fillRect(sx(17), sy(28), rw(10), rh(8));

  ctx.fillStyle = "#1565c0";
  ctx.fillRect(sx(3), sy(20), rw(22), rh(10));

  ctx.fillStyle = shirt;
  ctx.fillRect(sx(2), sy(14), rw(24), rh(6));
  ctx.fillRect(sx(-4), sy(16), rw(7), rh(10));
  ctx.fillRect(sx(25), sy(16), rw(7), rh(10));

  ctx.fillStyle = "#ffcc80";
  ctx.fillRect(sx(4), sy(2), rw(20), rh(14));

  ctx.fillStyle = "#c62828";
  ctx.fillRect(sx(2), sy(-2), rw(24), rh(6));
  ctx.fillRect(sx(6), sy(-8), rw(16), rh(8));

  ctx.fillStyle = "#000";
  ctx.fillRect(sx(18), sy(6), rw(4), rh(4));
  ctx.fillStyle = "#5d4037";
  ctx.fillRect(sx(14), sy(12), rw(11), rh(3));

  ctx.font = `bold ${Math.max(6, Math.floor(w * 0.28))}px Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const capCx = ox + w / 2;
  const capCy = sy(-4);
  ctx.strokeStyle = "#00356B";
  ctx.lineWidth = 1.25;
  ctx.fillStyle = "#fffef5";
  ctx.strokeText("Y", capCx, capCy);
  ctx.fillText("Y", capCx, capCy);
}

function drawPlayer() {
  const sx = player.x - camX;
  if (!autoPilot && performance.now() < player.invincibleUntilMs && Math.floor(performance.now() / 80) % 2 === 0) return;

  ctx.save();
  if (!player.facingRight) {
    ctx.translate(sx * 2 + player.w, 0);
    ctx.scale(-1, 1);
  }

  drawPlayerClassicVector(sx);

  ctx.restore();
}

function drawFlag() {
  if (state.layer === "underground") return;
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

function drawPipeWarpVignette() {
  const w = state.pipeWarpAnim;
  if (!w || !player) return;
  if (w.kind === "down" || w.kind === "up") {
    const u = Math.min(1, w.elapsed / w.dur);
    const g = ctx.createRadialGradient(CANVAS_W / 2, CANVAS_H / 2, 40, CANVAS_W / 2, CANVAS_H / 2, 440);
    g.addColorStop(0, `rgba(0,0,0,${u * 0.2})`);
    g.addColorStop(1, `rgba(0,0,0,${u * 0.72})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    const px = player.x - camX + player.w / 2;
    const py = player.y + player.h / 2;
    ctx.strokeStyle = `rgba(100,200,255,${0.35 * u})`;
    ctx.lineWidth = 3;
    for (let k = 0; k < 4; k++) {
      ctx.beginPath();
      ctx.arc(px, py, 12 + k * 18 + (w.elapsed * 40) % 24, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function drawHUD() {
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(0, 0, CANVAS_W, 56);

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

  if (player && player.powerStage >= 1) {
    ctx.fillStyle = player.powerStage >= 2 ? "#ff6f00" : "#ffb74d";
    ctx.font = "bold 13px 'Courier New'";
    ctx.textAlign = "center";
    const tier = player.powerStage >= 2 ? "FIRE" : "SUPER";
    const mini = player.greenShrink ? " · MINI" : "";
    ctx.fillText(`${tier}${mini}`, CANVAS_W / 2, 38);
  }

  ctx.fillStyle = "#9e9e9e";
  ctx.font = "9px 'Courier New'";
  ctx.textAlign = "center";
  if (state.layer === "underground") {
    const br = level && level.bonusSegment != null ? level.bonusSegment + 1 : "?";
    ctx.fillText(`BONUS ${br}/10   jump into red pipe lip (up) to exit    [ \u2190 ] [ \u2192 ]    [ Space ]`, CANVAS_W / 2, 44);
    ctx.fillStyle = "#90caf9";
    ctx.font = "9px 'Courier New'";
    const cap = level && level.bonusStarTotal != null ? level.bonusStarTotal : 3;
    ctx.fillText(`Stars ${state.bonusStars}/${cap} (count as coins +100)`, CANVAS_W / 2, 52);
  } else {
    ctx.fillText("[ \u2190 ] [ \u2192 ] move    [ Space ] jump    [ A ] fire", CANVAS_W / 2, 44);
    ctx.fillStyle = "#78909c";
    ctx.font = "8px 'Courier New'";
    ctx.fillText("Red warp pipe: stand on top + [ \u2193 ] bonus room", CANVAS_W / 2, 52);
  }

  ctx.fillStyle = "#9ccc65";
  ctx.font = "bold 11px 'Courier New'";
  ctx.textAlign = "right";
  ctx.fillText(`STAGE ${state.flagsPassed + 1}/${NUM_LEVELS}`, CANVAS_W - 10, 40);

  if (autoPilot) {
    ctx.fillStyle = "#ff5252";
    ctx.font = "bold 10px 'Courier New'";
    ctx.textAlign = "left";
    ctx.fillText("[AUTO]", 10, 50);
  }

  ctx.fillStyle = "#e63946";
  ctx.font = "20px Arial";
  ctx.textAlign = "right";
  if (autoPilot) {
    ctx.font = "bold 22px Arial";
    ctx.fillText("\u221e", CANVAS_W - 10, 22);
  } else {
    for (let i = 0; i < state.lives; i++) {
      ctx.fillText("♥", CANVAS_W - 10 - i * 22, 22);
    }
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
  ctx.fillText("presented by Guru Yarin", CANVAS_W / 2, 210);

  ctx.fillStyle = "#ccc";
  ctx.font = "16px 'Courier New'";
  ctx.fillText("Collect coins  +100    Stomp enemies  +200", CANVAS_W / 2, 280);
  ctx.fillText("10 stages · ~20k units · final flag wins  +2500", CANVAS_W / 2, 305);
  ctx.fillText("? blocks: red mushroom = grow / fire tier   green = mini (same jump)", CANVAS_W / 2, 335);
  ctx.fillStyle = "#bcaaa4";
  ctx.font = "14px 'Courier New'";
  ctx.fillText("Brown pipe: stand on top + S or down to enter underground bonus", CANVAS_W / 2, 358);

  ctx.fillStyle = "#a5d6a7";
  ctx.font = "13px 'Courier New'";
  if (isMobile) {
    ctx.fillText("Touch:  [ \u25C0 ] [ \u25B6 ] move    [ Space ] jump    [ A ] fire (2nd red)", CANVAS_W / 2, 372);
    ctx.fillText("Power resets when you lose a life", CANVAS_W / 2, 392);
  } else {
    ctx.fillText("[ \u2190 ] [ \u2192 ] move    [ Space ] jump    [ A ] fire after 2nd red mushroom", CANVAS_W / 2, 384);
    ctx.fillText("\u2191 and W also jump · green = smaller body, jump unchanged", CANVAS_W / 2, 404);
  }

  if (Math.floor(Date.now() / 600) % 2 === 0) {
    ctx.fillStyle = "#ffd700";
    ctx.font = "bold 22px 'Courier New'";
    ctx.fillText(isMobile ? "TAP TO START" : "PRESS SPACE TO START", CANVAS_W / 2, 430);
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
    for (const fish of level.fish)   drawFish(fish);
    for (const p of level.platforms) drawPlatform(p);
    drawWinterGroundSnow();
    for (const b of level.questionBlocks) drawQuestionBlock(b);
    for (const p of level.pipes)     drawPipe(p);
    for (const c of level.coins)     drawCoin(c);
    for (const m of level.mushrooms) drawMushroom(m);
    for (const e of level.enemies)   drawEnemy(e);
    for (const f of fireballs)       drawFireball(f);
    drawFlag();
  }
  if (player) drawPlayer();
  drawPipeWarpVignette();
  drawHUD();
  drawPopups();

  const submitting = state.phase === "submitting";
  const done       = state.phase === "done";
  const statusText = submitting ? "Saving score..."
                   : state.lastSubmitError
                     ? ""
                     : (sbClient ? "Score saved!" : "");
  const statusColor = submitting ? "#ffd700" : "#4caf50";

  if (state.phase === "gameover" || (submitting && !state.won) || (done && !state.won)) {
    drawOverlay("GAME OVER", "#e63946", [
      { text: `Score: ${state.score}` },
      { text: `Coins: ${state.coinsCollected}   Enemies: ${state.enemiesDefeated}` },
      ...(statusText ? [{ text: statusText, color: statusColor }] : []),
      ...(done && state.lastSubmitError
        ? [{ text: state.lastSubmitError, color: "#ffb74d" }]
        : []),
      ...(done && state.lastRank != null ? [{ text: `You rank #${state.lastRank}`, color: "#90caf9" }] : []),
    ], done);
  }

  if (state.phase === "win" || (submitting && state.won) || (done && state.won)) {
    drawOverlay("YOU WIN!", "#ffd700", [
      { text: "All 10 stages cleared!" },
      { text: `Final Score: ${state.score}` },
      { text: `Coins: ${state.coinsCollected}   Enemies: ${state.enemiesDefeated}` },
      ...(statusText ? [{ text: statusText, color: statusColor }] : []),
      ...(done && state.lastSubmitError
        ? [{ text: state.lastSubmitError, color: "#ffb74d" }]
        : []),
      ...(done && state.lastRank != null ? [{ text: `You rank #${state.lastRank}`, color: "#90caf9" }] : []),
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
    if (!res.ok) throw new Error(`session HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.sessionId || !data.token || typeof data.seed !== "number") {
      throw new Error("session response missing sessionId, token, or seed");
    }
    return data;
  } catch (e) {
    console.warn("startSession failed:", e.message);
    return null;
  }
}

async function submitScore() {
  state.phase = "submitting";
  state.lastRank = null;
  state.lastSubmitError = null;

  const sessionId = state.sessionId;
  const sessionToken = state.sessionToken;
  const payload = {
    sessionId,
    token: sessionToken,
    name: state.playerName || "Guest",
    score: state.score,
    coinsCollected: state.coinsCollected,
    enemiesDefeated: state.enemiesDefeated,
    won: state.won,
    playTimeMs: state.playTimeMs,
  };

  if (sessionId && sessionToken) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${EDGE_BASE}/submit-score`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify(payload),
      });
      clearTimeout(timeout);
      const text = await res.text();
      if (res.ok) {
        try {
          const result = JSON.parse(text);
          if (result.rank != null) state.lastRank = result.rank;
        } catch (_) {}
      } else {
        let errMsg = `Save failed (${res.status})`;
        try {
          const j = JSON.parse(text);
          if (j && j.error) errMsg = String(j.error);
        } catch (_) {}
        state.lastSubmitError = errMsg;
        console.warn("submit-score:", res.status, text);
      }
    } catch (e) {
      state.lastSubmitError =
        e.name === "AbortError" ? "Save timed out — try again" : (e.message || "Save failed");
      console.warn("submitScore failed:", e.message);
    }
  } else {
    state.lastSubmitError =
      "No game session — score not sent. Check network, ad blockers, or that Edge Functions are deployed.";
    console.warn("submitScore: no session token — score not saved. Check start-session Edge Function.");
  }

  state.phase = "done";
  await loadLeaderboard();
}

async function loadLeaderboard() {
  const el = document.getElementById("leaderboardList");
  if (!el) return;
  if (SUPABASE_URL === "YOUR_SUPABASE_URL") {
    el.innerHTML = "<li style='color:#555;font-size:10px'>Set SUPABASE_URL in game.js</li>";
    return;
  }

  try {
    let rows;
    if (sbClient) {
      const { data, error } = await sbClient
        .from("mario_scores")
        .select("name, score, created_at")
        .order("score", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      rows = data;
    } else {
      rows = await fetchLeaderboardTop10();
    }
    renderLeaderboard(Array.isArray(rows) ? rows : []);
  } catch (e) {
    console.warn("loadLeaderboard:", e);
    try {
      const fallbackRows = await fetchLeaderboardTop10();
      renderLeaderboard(Array.isArray(fallbackRows) ? fallbackRows : []);
    } catch (e2) {
      console.warn("loadLeaderboard fallback:", e2);
      el.innerHTML = "<li style='color:#555;font-size:11px'>Scores unavailable</li>";
    }
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
  markWarpPipes(level);
  player = createPlayer();
  camX   = 0;
  coinSpin = 0;

  state.score          = 0;
  state.lives          = autoPilot ? 999 : 3;
  state.coinsCollected = 0;
  state.enemiesDefeated = 0;
  state.won            = false;
  state.runStartMs     = Date.now();
  state.playTimeMs     = 0;
  state.popups         = [];
  state.flagsPassed    = 0;
  state.layer          = "surface";
  state.bonusStars     = 0;
  state.lastRank       = null;
  state.lastSubmitError = null;
  state.pipeWarpAnim   = null;
  surfaceLevelRef      = null;
  surfaceSave          = null;
  fireballs            = [];
  autoPilotLastX       = 80;
  autoPilotNoMoveAccum = 0;
  autoPilotRetreatLeft = 0;
  keys["Space"] = false;
  keys["KeyA"]  = false;
  state.phase          = "playing";
  requestAnimationFrame(() => {
    try {
      canvas.focus({ preventScroll: true });
    } catch (_) {}
  });
}

function resetToStart() {
  state.phase        = "start";
  state.sessionId    = null;
  state.sessionToken = null;
  state.lastRank     = null;
  state.lastSubmitError = null;
  state.pipeWarpAnim = null;
  keys["Space"] = false;
  keys["KeyA"]  = false;
  loadLeaderboard().catch(() => {});
}

// ============================================================
// INIT
// ============================================================
loadLeaderboard();
lastTs = performance.now();
requestAnimationFrame(gameLoop);
