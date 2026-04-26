// netlify/functions/capture-lane-rate.js
// ─────────────────────────────────────────────────────────────────────────
// Receives lane analytics events from the browser (origin/dest, trailer,
// rates, miles) and writes them to the `lane_rates` table using the Supabase
// service key. The browser used to write to Supabase directly via the anon
// key, which required a public-INSERT RLS policy that the linter flagged as
// always-true. This function lets us drop that policy entirely while
// preserving the analytics-capture flow.
//
// Defenses against pollution / abuse:
//   1. Method check     — only POST is accepted
//   2. Origin check     — only requests from our own site are accepted
//   3. Payload shape    — every required field must be present and the right
//                          type
//   4. Value sanity     — numeric ranges that are physically possible (no
//                          negative miles, no $1000/mile rates, etc.)
//   5. Field whitelist  — only the columns we expect are forwarded; any
//                          extra keys the client sends are silently dropped
//
// All defenses can be bypassed by a determined attacker (origin headers can
// be forged with curl), but together they raise the bar enough that casual
// pollution becomes uninteresting. If we ever see real abuse, add per-IP
// rate limiting in front of this — for now the validation is enough.
// ─────────────────────────────────────────────────────────────────────────

const SUPABASE_URL  = process.env.SUPABASE_URL  || 'https://xgrmbhmgcsbnazupfybd.supabase.co';
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const ALLOWED_ORIGINS = [
  'https://quickfreightcalc.com',
  'https://www.quickfreightcalc.com',
];

// Field whitelist — only these keys are forwarded to Supabase. Anything else
// the client sends is dropped. Keep this list in sync with the lane_rates
// table schema.
const ALLOWED_FIELDS = [
  'origin_city', 'origin_state', 'origin_region',
  'dest_city',   'dest_state',   'dest_region',
  'trailer',
  'entered_rpm', 'dat_rpm', 'difference',
  'miles', 'final_quote', 'is_manual',
];

const VALID_TRAILERS = new Set(['van', 'reefer', 'flatbed']);
const VALID_REGIONS  = new Set([
  'northeast', 'southeast', 'midwest', 'southwest', 'west', 'national',
]);

// Validates the incoming payload. Returns { ok:true, clean } on success or
// { ok:false, reason } on failure. The `clean` object is a fresh whitelisted
// copy — never trust the original to flow through.
function validatePayload(body){
  if(!body || typeof body !== 'object') return { ok:false, reason:'body-not-object' };

  // Required strings (cities and trailer)
  const reqStrings = ['origin_city', 'dest_city', 'trailer'];
  for(const k of reqStrings){
    if(typeof body[k] !== 'string' || !body[k].trim() || body[k].length > 100){
      return { ok:false, reason:`bad-${k}` };
    }
  }
  if(!VALID_TRAILERS.has(body.trailer)){
    return { ok:false, reason:'bad-trailer-value' };
  }

  // Optional strings (state codes, regions). If present, must match shape.
  for(const k of ['origin_state', 'dest_state']){
    if(body[k] !== null && body[k] !== undefined){
      if(typeof body[k] !== 'string' || body[k].length > 4){
        return { ok:false, reason:`bad-${k}` };
      }
    }
  }
  for(const k of ['origin_region', 'dest_region']){
    if(body[k] !== null && body[k] !== undefined){
      if(typeof body[k] !== 'string' || !VALID_REGIONS.has(body[k])){
        return { ok:false, reason:`bad-${k}` };
      }
    }
  }

  // Numeric ranges. Rates are dollars per mile; quotes are total dollars.
  // Bounds are deliberately wide so we don't accidentally reject legitimate
  // outliers, but tight enough to reject obvious garbage.
  const numChecks = [
    ['entered_rpm',  0,    50],     // $0–$50/mile
    ['dat_rpm',      0,    50],
    ['difference', -50,    50],
    ['miles',        0, 10000],     // 10k miles is hard physical max for a single load
  ];
  for(const [k, min, max] of numChecks){
    const v = body[k];
    if(typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max){
      return { ok:false, reason:`bad-${k}` };
    }
  }

  // Optional final_quote (may be null when result hasn't computed yet)
  if(body.final_quote !== null && body.final_quote !== undefined){
    const q = body.final_quote;
    if(typeof q !== 'number' || !Number.isFinite(q) || q < 0 || q > 1_000_000){
      return { ok:false, reason:'bad-final_quote' };
    }
  }

  // is_manual is a boolean toggle; coerce loose values to strict
  if(typeof body.is_manual !== 'boolean'){
    return { ok:false, reason:'bad-is_manual' };
  }

  // Build the whitelisted clean object — never let the client sneak in
  // arbitrary extra columns that might match a future schema field.
  const clean = {};
  for(const k of ALLOWED_FIELDS){
    if(body[k] !== undefined) clean[k] = body[k];
  }
  return { ok:true, clean };
}

exports.handler = async function(event){
  // Method gate — only POST is allowed
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // Origin gate — block requests from anywhere other than our own site.
  // This is bypassable with curl but blocks ~all casual abuse.
  const origin = event.headers.origin || event.headers.Origin || '';
  if(!ALLOWED_ORIGINS.includes(origin)){
    return { statusCode: 403, body: 'Forbidden' };
  }

  // Service key must be configured — failing closed if missing
  if(!SERVICE_KEY){
    console.error('capture-lane-rate: SUPABASE_SERVICE_KEY not configured');
    return { statusCode: 500, body: 'Server misconfigured' };
  }

  // Parse body. Reject malformed JSON without a stack trace leak.
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch(e){
    return { statusCode: 400, body: 'Bad JSON' };
  }

  // Validate shape
  const result = validatePayload(body);
  if(!result.ok){
    console.warn('capture-lane-rate: rejected payload —', result.reason);
    // Generic 400 response — don't leak which field failed, since that
    // helps an attacker probe the validation.
    return { statusCode: 400, body: 'Invalid payload' };
  }

  // Forward to Supabase using the service key. The service key bypasses RLS,
  // so no public INSERT policy is needed on lane_rates anymore.
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/lane_rates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(result.clean),
    });
    if(!resp.ok){
      const text = await resp.text();
      console.error('capture-lane-rate: Supabase rejected insert —', resp.status, text);
      return { statusCode: 502, body: 'Upstream error' };
    }
    // 204 No Content — the browser doesn't need anything back
    return { statusCode: 204, body: '' };
  } catch(e){
    console.error('capture-lane-rate: fetch failed —', e.message);
    return { statusCode: 502, body: 'Upstream error' };
  }
};
