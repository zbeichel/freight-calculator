// netlify/functions/sync-rate-history.js
// ─────────────────────────────────────────────────────────────────────────
// Reads the deployed rates.json and upserts every history snapshot into
// the public.rate_history table using the Supabase service key. Runs once
// per Netlify deploy via the onSuccess build plugin (see netlify.toml).
//
// The previous flow expected a public-INSERT RLS policy on rate_history so
// the data could be written from somewhere — but no automated writer ever
// existed in the codebase, so the policy was both required and unused.
// This function fills the gap and lets us drop the public policy.
//
// Idempotency: every deploy re-syncs every snapshot. The upsert relies on
// a unique constraint on (snapshot_date, region) — without that, repeated
// deploys would create duplicate rows. The migration in supabase_lockdown.sql
// adds that constraint.
//
// rates.json `history[]` shape:
//   [{
//     date:   "2026-04-15",
//     label:  "Apr 2026",
//     regions: {
//       northeast: { van: 2.38, reefer: 2.64, flatbed: 3.24 },
//       southeast: { ... },
//       ...
//     }
//   }, ...]
//
// Flattened into one DB row per (date, region):
//   { snapshot_date: "2026-04-15", region: "northeast",
//     van: 2.38, reefer: 2.64, flatbed: 3.24 }
// ─────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xgrmbhmgcsbnazupfybd.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;

// Loads rates.json from the deployed bundle. The site's publish directory
// is the repo root (per netlify.toml `publish = "."`), so rates.json sits
// next to index.html. When this function runs as a build plugin, the cwd
// is the build root, which is also the repo root — same place.
function loadRatesJson(){
  const candidates = [
    path.join(process.cwd(), 'rates.json'),
    path.join(__dirname, '..', '..', 'rates.json'),
  ];
  for(const p of candidates){
    if(fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error('rates.json not found in any expected location');
}

// Flattens history[].regions{} into one row per (date, region). Filters out
// any region whose values aren't all numeric — defensive guard against a
// malformed snapshot accidentally getting written to history.
function flattenHistory(history){
  if(!Array.isArray(history)) return [];
  const rows = [];
  for(const snap of history){
    if(!snap?.date || !snap?.regions) continue;
    for(const [region, vals] of Object.entries(snap.regions)){
      if(!vals) continue;
      const { van, reefer, flatbed } = vals;
      if(typeof van !== 'number' || typeof reefer !== 'number' || typeof flatbed !== 'number'){
        console.warn(`sync-rate-history: skipping ${snap.date}/${region} — non-numeric values`);
        continue;
      }
      rows.push({
        snapshot_date: snap.date,
        region,
        van,
        reefer,
        flatbed,
      });
    }
  }
  return rows;
}

// Upserts rows into rate_history. Uses ON CONFLICT on (snapshot_date, region)
// to make the operation idempotent — re-running on the same data updates
// in place rather than duplicating. PostgREST takes the conflict columns
// in the `on_conflict` query parameter.
async function upsertRows(rows){
  if(!rows.length) return { inserted:0, updated:0 };
  const url = `${SUPABASE_URL}/rest/v1/rate_history?on_conflict=snapshot_date,region`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      // Prefer: resolution=merge-duplicates makes ON CONFLICT do an UPDATE
      // rather than ignoring duplicates. Without this, repeated runs would
      // be no-ops and we'd never pick up corrections to old snapshots.
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if(!resp.ok){
    const text = await resp.text();
    throw new Error(`Supabase upsert failed: ${resp.status} ${text}`);
  }
  // Supabase returns no body with return=minimal; we report the row count
  // we sent rather than how many were actually changed (PostgREST doesn't
  // distinguish insert vs. update in the response).
  return { synced: rows.length };
}

// Main routine — also exported as a Netlify function handler so this can
// run either as a build plugin (called from the wrapper plugin) or be
// invoked manually via the function URL for one-off resyncs.
async function run(){
  if(!SERVICE_KEY){
    throw new Error('SUPABASE_SERVICE_KEY env var not configured');
  }
  const rates = loadRatesJson();
  const rows  = flattenHistory(rates.history);
  const result = await upsertRows(rows);
  return { rates_loaded:true, ...result };
}

exports.run = run;

// Function handler for manual invocation (e.g. /.netlify/functions/sync-rate-history).
// Locked behind a token so it can't be called by random visitors. The token
// lives in Netlify env vars alongside the service key.
exports.handler = async function(event){
  const expected = process.env.SYNC_TOKEN;
  const provided = event.headers['x-sync-token'] || event.headers['X-Sync-Token'];
  if(!expected || provided !== expected){
    return { statusCode: 403, body: 'Forbidden' };
  }
  try {
    const result = await run();
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch(e){
    console.error('sync-rate-history failed:', e);
    return { statusCode: 500, body: e.message };
  }
};
