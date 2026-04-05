// Netlify serverless function — proxies EIA API to avoid CORS
// Deploy to: netlify/functions/diesel-price.js in your GitHub repo
// Set EIA_API_KEY as an environment variable in Netlify dashboard:
//   Site configuration → Environment variables → Add variable
//   Key: EIA_API_KEY   Value: your_eia_key_here

const SERIES = {
  R10: 'EMD_EPD2D_PTE_R10_DPG', // East Coast
  R20: 'EMD_EPD2D_PTE_R20_DPG', // Midwest
  R30: 'EMD_EPD2D_PTE_R30_DPG', // Gulf Coast
  R40: 'EMD_EPD2D_PTE_R40_DPG', // Rocky Mountain
  R50: 'EMD_EPD2D_PTE_R50_DPG', // West Coast
  NUS: 'EMD_EPD2D_PTE_NUS_DPG', // National Average
};

exports.handler = async (event) => {
  const region = event.queryStringParameters?.region || 'NUS';
  const seriesId = SERIES[region];

  if (!seriesId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid region' }),
    };
  }

  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'EIA_API_KEY not configured' }),
    };
  }

  const url = `https://api.eia.gov/v2/petroleum/pri/gnd/data/`
    + `?api_key=${apiKey}`
    + `&frequency=weekly`
    + `&data[0]=value`
    + `&facets[series][]=${seriesId}`
    + `&sort[0][column]=period`
    + `&sort[0][direction]=desc`
    + `&length=2`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`EIA returned HTTP ${resp.status}`);
    const data = await resp.json();

    const rows = data?.response?.data;
    if (!rows || rows.length === 0) throw new Error('No data');

    const latest = rows[0];
    const price = parseFloat(latest.value);
    const period = latest.period;

    if (isNaN(price)) throw new Error('Invalid price');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ price, period, region, seriesId }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
