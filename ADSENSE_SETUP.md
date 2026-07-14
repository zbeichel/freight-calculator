# Google AdSense Setup Guide

This site is already wired up for Google AdSense. Ad slots are in place on the
main page (`index.html`): a **left rail**, a **right rail** (both shown only on
wide monitors), and a **bottom banner** (shown on every screen size).

**Nothing shows until you finish the steps below.** Until you paste in a real
publisher ID, no ads and no Google scripts load — the live site looks exactly
as it does today. So you can ship this safely and turn ads on once you're
approved.

---

## Step 1 — Create a Google AdSense account

1. Go to **<https://adsense.google.com>** and click **Get started**.
2. Sign in with the Google account you want to use (e.g. your Gmail).
3. Enter your site URL: **`quickfreightcalc.com`**.
4. Choose your country and accept the AdSense Terms.
5. AdSense will give you a small verification code snippet. **You don't have to
   paste that manually** — see Step 2, which already handles connecting the site.

## Step 2 — Get your Publisher ID and verify the site

1. In the AdSense dashboard, go to **Account → Settings → Account information**.
2. Copy your **Publisher ID**. It looks like:

   ```
   ca-pub-1234567890123456
   ```

3. Open **`index.html`**, scroll to the bottom (search for `ADS_CONFIG`), and
   replace the placeholder:

   ```js
   const ADS_CONFIG = {
     client: "ca-pub-XXXXXXXXXXXXXXXX",   // ← paste your real ID here
     ...
   ```

   As soon as this is a real ID (no more `XXXX`), the page loads the AdSense
   library, which is exactly what Google needs to verify your site.

4. Commit, push, and let Netlify deploy. Back in AdSense, click **Verify** /
   **Request review**.

> **Approval takes a few days to ~2 weeks.** Google reviews your site for
> content and policy compliance. During this time the ad slots stay blank —
> that's normal.

## Step 3 — Create your three ad units

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

## How the placement behaves

- **Left & right rails** are fixed in the page margins and only appear on wide
  screens (~1560px+), so they never overlap the calculator. On laptops,
  tablets, and phones they stay hidden automatically.
- **Bottom banner** is a responsive horizontal unit above the footer and shows
  on all screen sizes.
- Want a rail to be a different size or want ads on the other tool pages
  (`bulk.html`, `lanes.html`, etc.)? The same `ADS_CONFIG` pattern can be copied
  in — ask and it can be added.

## Good to know

- **Don't click your own ads** — Google prohibits it and can suspend your
  account. Use their preview tools instead of clicking live ads.
- The **Privacy Policy** (`privacy.html`) has already been updated to disclose
  AdSense cookies and link to Google's opt-out settings, which AdSense's program
  policies require.
- If you'd rather have Google decide placement automatically (including an
  auto-anchor ad at the bottom of mobile), you can turn on **Auto ads** in the
  AdSense dashboard — it works alongside the manual units above.
- Payment: AdSense pays out once your balance passes the threshold (usually
  \$100). You'll set up payment details in **Payments** after approval.
