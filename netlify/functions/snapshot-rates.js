// netlify/functions/snapshot-rates.js
// Triggered by Netlify deploy hook — reads rates.json and writes a snapshot to Supabase rate_history
// Only snapshots if rates have changed since the last snapshot

const https = require('https');

const SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';

function httpsRequest(url, options, body){
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e){ resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if(body) req.write(body);
    req.end();
  });
}

async function fetchRatesJson(){
  return new Promise((resolve, reject) => {
    // Read from the deployed site — use the Netlify URL
    const siteUrl = process.env.URL || process.env.DEPLOY_URL || 'https://quickfreightcalc.com';
    const url = `${siteUrl}/rates.json`;
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e){ reject(new Error('Could not parse rates.json')); }
      });
    }).on('error', reject);
  });
}

async function getLastSnapshot(serviceKey){
  const url = `${SUPABASE_URL}/rest/v1/rate_history?select=snapshot_date&order=snapshot_date.desc&limit=1`;
  const resp = await httpsRequest(url, {
    method: 'GET',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
    }
  });
  if(resp.body?.length) return resp.body[0].snapshot_date;
  return null;
}

async function insertSnapshot(serviceKey, date, region, van, reefer, flatbed){
  const url = `${SUPABASE_URL}/rest/v1/rate_history`;
  return httpsRequest(url, {
    method: 'POST',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    }
  }, JSON.stringify({ snapshot_date: date, region, van, reefer, flatbed }));
}

exports.handler = async function(event, context){
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if(!serviceKey){
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing SUPABASE_SERVICE_KEY env var' }) };
  }

  try {
    // Load current rates.json
    const rates = await fetchRatesJson();
    if(!rates?.regions){
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid rates.json format' }) };
    }

    // Use the updated date from rates.json, or today
    const snapshotDate = rates.updated
      ? new Date(rates.updated).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0];

    // Check if we already have a snapshot for this date
    const lastSnapshot = await getLastSnapshot(serviceKey);
    if(lastSnapshot === snapshotDate){
      console.log(`Snapshot for ${snapshotDate} already exists — skipping`);
      return {
        statusCode: 200,
        body: JSON.stringify({ message: `Snapshot for ${snapshotDate} already exists`, skipped: true })
      };
    }

    // Insert a row for each region
    const regions = Object.keys(rates.regions);
    const results = [];
    for(const region of regions){
      const r = rates.regions[region];
      if(!r.van && !r.reefer && !r.flatbed) continue; // skip empty regions
      const resp = await insertSnapshot(serviceKey, snapshotDate, region, r.van, r.reefer, r.flatbed);
      results.push({ region, status: resp.status });
    }

    console.log(`Snapshotted ${results.length} regions for ${snapshotDate}`);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: `Snapshot complete for ${snapshotDate}`, regions: results })
    };

  } catch(err){
    console.error('snapshot-rates error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
