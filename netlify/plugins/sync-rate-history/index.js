// netlify/plugins/sync-rate-history/index.js
// ─────────────────────────────────────────────────────────────────────────
// Netlify build plugin that runs after a successful deploy. Calls the
// sync-rate-history function's `run()` export to push any new rates.json
// snapshots into Supabase.
//
// We use onSuccess (not onPostBuild) so the sync only happens after the
// deploy actually goes live. If the deploy fails for unrelated reasons,
// we don't sync — keeping the database aligned with what's actually
// serving.
// ─────────────────────────────────────────────────────────────────────────

const path = require('path');

module.exports = {
  async onSuccess({ utils }){
    try {
      // Resolve the function relative to the plugin's own location, then
      // require it so any thrown errors surface with a real stack trace.
      const fnPath = path.resolve(__dirname, '..', '..', 'functions', 'sync-rate-history.js');
      const { run } = require(fnPath);
      const result = await run();
      console.log('[sync-rate-history] Synced rates.json → rate_history:', result);
    } catch(e){
      // Don't fail the entire deploy if the sync fails — the site is
      // already live and serving the new rates.json. Surface the error
      // loudly in the build log so it gets noticed and re-run manually.
      console.error('[sync-rate-history] Sync failed:', e.message);
      utils.build.failPlugin('rate_history sync failed — site is live but database not updated. Check function logs.', { error: e });
    }
  },
};
