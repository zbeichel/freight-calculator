# Google AdSense Setup Guide

This site is wired up for Google AdSense under Publisher ID
**`ca-pub-5621259704181475`**. Ad slots are in place on the main page
(`index.html`): a **left rail**, a **right rail** (both shown only on wide
monitors), and a **bottom banner** (shown on every screen size).

**Verification is already handled** by two things in the repo, so Google's
"connect your site" step can detect the site:

- a `<meta name="google-adsense-account" ...>` tag in the `<head>` of every page, and
- an `ads.txt` file at the site root authorizing Google to serve ads.

The AdSense loader `<script>` is **not** in the pages' `<head>` any more (since
November 2026): it's about 250 KB of script and was the biggest drag on the
Lighthouse performance score while showing no ads. `index.html` now loads it
only when there is an ad to show (see "How the placement behaves").

**Ads themselves stay hidden** until you paste real *slot IDs* (Step 2) after
approval — so no empty ad frames show while you wait.

---

## Step 1 — Verify the site (do this now)

1. Push the current changes and let Netlify deploy (see "Deploying" below).
2. In AdSense, on the **"Connect your site to AdSense"** / **"Get your site
   ready"** screen, click **Verify** / **Request review**.
   - Choose the **meta tag** method (or ads.txt) — both are present. The
     code-snippet method won't find the loader, because it now loads only
     when an ad is shown.
   - If it says it still can't find the code, wait ~15 minutes for the deploy to
     go live and Google to re-crawl, then click Verify again.

> **Approval takes a few days to ~2 weeks.** Google reviews your site for
> content and policy compliance. During this time the ad slots stay blank —
> that's normal.

## Step 2 — Create your three ad units (after approval)

Once approved, create the actual ad units:

1. In AdSense go to **Ads → By ad unit → Display ads**.
2. Create **three** units and copy each one's **slot ID** (the 10-digit number
   shown as `data-ad-slot="1234567890"`):

   | Unit to create      | Recommended type   | Goes into    |
   | ------------------- | ------------------ | ------------ |
   | Left skyscraper     | Vertical           | `slots.left` |
   | Right skyscraper    | Vertical           | `slots.right` |
   | Bottom banner       | Horizontal         | `slots.bottom` |

3. Back in **`index.html`**, fill in the slot IDs in `ADS_CONFIG`:

   ```js
   slots: {
     left:   "1111111111",   // left skyscraper slot ID
     right:  "2222222222",   // right skyscraper slot ID
     bottom: "3333333333"    // bottom banner slot ID
   }
   ```

4. Commit, push, deploy. Real ads will begin appearing (may take an hour or two
   the first time).

---

## Deploying

This is a Netlify site that deploys from git. To push a change live:

```
git add -A
git commit -m "your message"
git push
```

Netlify builds and publishes automatically within a minute or two. You can watch
it in your Netlify dashboard. The AdSense files live at:

- `ads.txt` → served at `https://quickfreightcalc.com/ads.txt`
- verification meta tag → in the `<head>` of every `.html` page

---

## How the placement behaves

- **Left & right rails** are fixed in the page margins and only appear on wide
  screens (~1560px+), so they never overlap the calculator. On laptops,
  tablets, and phones they stay hidden automatically.
- **Bottom banner** is a responsive horizontal unit above the footer and shows
  on all screen sizes.
- **The AdSense library only downloads when an ad will show**: once real slot
  IDs are in `ADS_CONFIG`, for visitors who aren't Pro, after the page has
  finished loading. Pro subscribers and pages without ads never download it.
- **Pro subscribers never see ads.** The moment a signed-in Pro account is
  confirmed, all ad slots are hidden and no ads are requested. This is checked
  instantly from the cached Pro status on load (so a Pro user never even briefly
  sees an ad) and again whenever Pro status changes.
- Want a rail to be a different size or want ads on the other tool pages
  (`bulk.html`, `lanes.html`, etc.)? The same `ADS_CONFIG` pattern can be copied
  in — ask and it can be added.

## Good to know

- **Don't click your own ads** — Google prohibits it and can suspend your
  account. Use their preview tools instead of clicking live ads.
- The **Privacy Policy** (`privacy.html`) has already been updated to disclose
  AdSense cookies and link to Google's opt-out settings, which AdSense's program
  policies require.
- **Auto ads** (Google deciding placement, including an anchor ad at the bottom
  of mobile) need the loader on every page. With the on-demand loading above,
  Auto ads would only run on the calculator page, after the slot IDs are set.
  Turning them on everywhere means putting the loader back in each page's
  `<head>`, which costs page speed — ask if you want that.
- Payment: AdSense pays out once your balance passes the threshold (usually
  \$100). You'll set up payment details in **Payments** after approval.
