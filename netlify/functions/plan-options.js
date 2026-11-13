// netlify/functions/plan-options.js
// What the pages can offer right now (public, no sign-in): which plans can be billed
// yearly (their yearly Stripe price is set: STRIPE_PRICE_ID_*_YEARLY) and the free
// trial (netlify/lib/plans.js). The sign-up page and the upgrade windows use it to
// show the monthly/yearly switch and "Start free trial" only when they'll work.
//
// GET → { yearly: ['pro', 'plus', 'max'], prices: { pro: { month, year }, … },
//         trial: { days, plans, dailyLimit } }
const { yearlyPlans, PLAN_PRICE, TRIAL_DAYS, TRIAL_PLANS, TRIAL_DAILY_LIMIT } = require('../lib/plans.js');

exports.handler = async function(event){
  if(event.httpMethod !== 'GET'){
    return { statusCode: 405, body: 'Method not allowed' };
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
    body: JSON.stringify({
      yearly: yearlyPlans(),
      prices: PLAN_PRICE,
      trial: { days: TRIAL_DAYS, plans: TRIAL_PLANS, dailyLimit: TRIAL_DAILY_LIMIT },
    }),
  };
};
