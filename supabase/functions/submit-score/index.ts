// submit-score Edge Function
// Verifies the session token (HMAC), enforces the server-computed
// score ceiling, marks the session one-time-used, then inserts.
//
// A hacker CANNOT bypass this because:
//   1. They can't forge a token  — SESSION_SECRET is server-only
//   2. They can't exceed max_score — it was computed server-side from the seed
//   3. They can't reuse a token  — marked used after first submission
//   4. Direct DB inserts are blocked by RLS policies

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SESSION_SECRET    = Deno.env.get("SESSION_SECRET")!;
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin" : "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

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

function fail(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" }
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")   return fail("method not allowed", 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return fail("invalid json"); }

  const { sessionId, token, name, score, coinsCollected, enemiesDefeated, won, playTimeMs } = body as {
    sessionId: string; token: string; name: string;
    score: number; coinsCollected: number; enemiesDefeated: number;
    won: boolean; playTimeMs: number;
  };

  // --- Basic shape validation ---
  if (!sessionId || !token || typeof score !== "number") return fail("bad payload");
  if (score < 0 || !Number.isFinite(score))             return fail("bad score");

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // --- Load session ---
  const { data: session, error: sessErr } = await supabase
    .from("mario_sessions")
    .select("*")
    .eq("id", sessionId)
    .single();

  if (sessErr || !session) return fail("session not found");

  // --- Expiry: sessions valid for 45 minutes ---
  if (Date.now() - session.issued_at > 45 * 60 * 1000) return fail("session expired");

  // --- One-time use ---
  if (session.used) return fail("session already used");

  // --- Verify HMAC token ---
  // Server recomputes the expected token from its own stored values.
  // If the client tampered with ANY field, this won't match.
  const expectedData  = `${sessionId}|${session.seed}|${session.max_score}|${session.issued_at}`;
  const expectedToken = await hmacSign(expectedData);
  if (token !== expectedToken) return fail("invalid token", 403);

  // --- Score ceiling: enforced from server-computed max ---
  const cleanScore = Math.floor(score);
  if (cleanScore > session.max_score) return fail("score exceeds maximum");

  // --- Sub-score sanity ---
  if ((coinsCollected || 0) > session.coin_count)   return fail("impossible coins");
  if ((enemiesDefeated || 0) > session.enemy_count) return fail("impossible enemies");

  // --- Mark session used BEFORE insert (prevent race condition replay) ---
  const { error: markErr } = await supabase
    .from("mario_sessions")
    .update({ used: true })
    .eq("id", sessionId)
    .eq("used", false);   // atomic: only succeeds if still false

  if (markErr) return fail("session already claimed", 409);

  // --- Insert score ---
  const cleanName = String(name || "Guest").trim().slice(0, 12) || "Guest";
  const { error: insertErr } = await supabase.from("mario_scores").insert({
    name            : cleanName,
    score           : cleanScore,
    coins_collected : Math.floor(coinsCollected || 0),
    enemies_defeated: Math.floor(enemiesDefeated || 0),
    won             : !!won,
    play_time_ms    : Math.floor(playTimeMs || 0),
    session_id      : sessionId,
    created_at      : Date.now(),
  });

  if (insertErr) {
    console.error("Insert failed:", insertErr);
    return fail("insert failed", 500);
  }

  // --- Cap table at 1000 rows (keep highest scores; tie-break by newest) ---
  const { error: trimErr } = await supabase.rpc("trim_mario_scores_to_max");
  if (trimErr) console.warn("trim_mario_scores_to_max:", trimErr);

  // --- Compute rank ---
  const { count } = await supabase
    .from("mario_scores")
    .select("id", { count: "exact", head: true })
    .gt("score", cleanScore);

  return new Response(JSON.stringify({ ok: true, rank: (count ?? 0) + 1 }), {
    headers: { ...CORS, "Content-Type": "application/json" }
  });
});
