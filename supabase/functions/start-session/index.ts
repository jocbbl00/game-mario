// start-session Edge Function
// Generates a server-signed session with a level seed.
// The server computes the maximum achievable score for that seed
// and stores it — the client can never exceed it on submission.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SESSION_SECRET    = Deno.env.get("SESSION_SECRET")!;
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin" : "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

// ============================================================
// PRNG — must be byte-for-byte identical to game.js makeRNG()
// ============================================================
function makeRNG(seed: number) {
  let s = ((seed ^ 0xdeadbeef) >>> 0);
  if (s === 0) s = 1;
  return (): number => {
    s ^= (s << 13); s = s >>> 0;
    s ^= (s >> 17); s = s >>> 0;
    s ^= (s << 5);  s = s >>> 0;
    return s / 4294967296;
  };
}

// ============================================================
// SERVER-SIDE LEVEL STATS
// Runs the EXACT same RNG sequence as generateLevel() in game.js
// but only counts coins and enemies — no entity objects needed.
// ============================================================
function computeLevelStats(seed: number): { coinCount: number; enemyCount: number; maxScore: number } {
  const TILE    = 40;
  const WORLD_W = 20000;
  const GROUND_Y = 520; // CANVAS_H - TILE

  const rng = makeRNG(seed);
  let coinCount  = 0;
  let enemyCount = 0;

  // --- GROUND (advance RNG same as client) ---
  for (let x = 0; x < WORLD_W; x += TILE) {
    const gapRoll = rng();
    if (x > 800 && gapRoll < 0.04 && x < WORLD_W - 600) {
      const sz = Math.floor(rng() * 2 + 1);
      x += TILE * sz;
    }
  }

  // --- ELEVATED PLATFORMS ---
  const numPlat = 25 + Math.floor(rng() * 20);
  let px = 300;
  for (let i = 0; i < numPlat; i++) {
    px += 200 + Math.floor(rng() * 250);
    if (px > WORLD_W - 600) break;

    const pwTiles = 2 + Math.floor(rng() * 4);
    const pw      = pwTiles * TILE;
    rng(); // pyIdx (height) — must consume same RNG call

    const nCoins = Math.floor(rng() * 3) + 1;
    for (let c = 0; c < nCoins; c++) {
      const cx = px + c * TILE + TILE / 2;
      if (cx < px + pw) coinCount++;
    }

    const eRoll = rng();
    if (eRoll > 0.5) {
      rng(); // dirRoll — must consume same RNG call
      enemyCount++;
    }
  }

  // --- FLOATING COIN ROWS ---
  const nRows = 15 + Math.floor(rng() * 10);
  for (let i = 0; i < nRows; i++) {
    rng(); // rx
    rng(); // ry
    const len = 3 + Math.floor(rng() * 5);
    coinCount += len;
  }

  // --- GROUND ENEMIES ---
  const nGround = 10 + Math.floor(rng() * 8);
  for (let i = 0; i < nGround; i++) {
    rng(); // ex
    rng(); // dirRoll
    enemyCount++;
  }

  // Pipes — just consume RNG calls, no entities to count
  const nPipes = 8 + Math.floor(rng() * 5);
  for (let i = 0; i < nPipes; i++) {
    rng(); rng(); // pipex, pipeh
  }

  // Question blocks — same RNG consumption as game.js generateLevel()
  const nQ = 8 + Math.floor(rng() * 5);
  for (let i = 0; i < nQ; i++) {
    rng(); // qx
    rng(); // qy
  }

  // maxScore = coins + enemies + win clear + max time + max per-segment flag bonuses (9×500)
  const maxScore = coinCount * 100 + enemyCount * 200 + 2500 + 2000 + 4500;
  return { coinCount, enemyCount, maxScore };
}

// ============================================================
// HMAC-SHA256 using SESSION_SECRET (server-only, never sent to client)
// ============================================================
async function hmacSign(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// ============================================================
// HANDLER
// ============================================================
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")   return new Response("method not allowed", { status: 405, headers: CORS });

  const supabase  = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const sessionId = crypto.randomUUID();
  const seed      = Math.floor(Math.random() * 0xFFFFFFFF);
  const issuedAt  = Date.now();

  const { coinCount, enemyCount, maxScore } = computeLevelStats(seed);

  // Token signs: sessionId|seed|maxScore|issuedAt
  // The client receives sessionId + token but NEVER sees SESSION_SECRET.
  // On submit, the server recomputes this token and compares.
  const tokenData = `${sessionId}|${seed}|${maxScore}|${issuedAt}`;
  const token     = await hmacSign(tokenData);

  const { error } = await supabase.from("mario_sessions").insert({
    id          : sessionId,
    seed,
    max_score   : maxScore,
    coin_count  : coinCount,
    enemy_count : enemyCount,
    issued_at   : issuedAt,
    token,
    used        : false,
  });

  if (error) {
    console.error("Session insert failed:", error);
    return new Response(JSON.stringify({ error: "session creation failed" }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" }
    });
  }

  // Return sessionId + token + seed to client.
  // max_score is NOT returned — client never knows the ceiling.
  return new Response(JSON.stringify({ sessionId, token, seed }), {
    headers: { ...CORS, "Content-Type": "application/json" }
  });
});
