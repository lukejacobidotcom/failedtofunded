# MFFU Conquest Attribution Contract

## Objective

Join every conquest ad click to the exact registration, paid customer, revenue, repeat purchase, and LTV outcome without depending on Google Ads' registration conversion.

## Identifiers

- `mffu_csid`: one acquisition-journey ID generated on the landing page and forwarded to checkout. This is the primary attribution join key.
- `mffu_vid`: a first-party browser ID used to recognize repeat visits before login. It is not a customer ID and contains no PII.
- Google click IDs: `gclid`, `gbraid`, `wbraid`, and `msclkid` are preserved unchanged for ad-platform feedback.
- `user_id`: assigned only after registration. The backend joins it to `mffu_csid`.
- `order_id` or receipt ID: the deduplication key for paid conversion uploads and revenue events.

## Frontend events

The page pushes these events to `window.dataLayer`:

- `mffu_conquest_view`
- `mffu_competitor_selected`
- `mffu_plan_selected`
- `mffu_conquest_cta_click`
- `mffu_coupon_copy`
- `mffu_rescue_click`
- `mffu_faq_open`

Every event includes `mffu_event_id`, `mffu_csid`, `mffu_vid`, competitor, plan, offer, landing page, landing variant, page path, and timestamp. CTA events also include CTA location and destination.

## Required production work

1. Put this page on `myfundedfutures.com` and retain `marketing.js` on the landing page and checkout route.
2. Configure GTM to map the seven data-layer events and their parameters into GA4.
3. On checkout load, read `mffu_csid`, `mffu_vid`, UTMs, and Google click IDs from the URL, then persist them in a first-party cookie or server session.
4. On registration, write an immutable attribution row keyed by `user_id` and `mffu_csid`.
5. On payment, join the receipt to that user and attribution row. Do not rely on the coupon or landing page as the join key.
6. Upload the paid purchase to Google Ads using the original click ID, conversion timestamp, currency, value, and unique order ID. Account creation should remain a secondary conversion; paid purchase should become the primary bidding signal after validation.
7. Send the same purchase event to GA4 with `user_id`, `transaction_id`, value, currency, and `mffu_csid`.
8. Replicate attribution into Fabric so the dashboard can calculate paid CAC, first-product mix, 30/60/90-day revenue, repeat purchase rate, and LTV by campaign, search term, ad, competitor, plan, and CTA.
9. Integrate the identifiers and marketing tags with MFFU's consent manager and Google Consent Mode before production rollout.

## Suggested attribution table

`fact_acquisition_attribution`

| Field | Purpose |
| --- | --- |
| `mffu_csid` | Primary acquisition journey key |
| `mffu_vid` | Anonymous returning-browser key |
| `user_id` | Registration/customer join |
| `first_seen_at` | Landing timestamp |
| `registered_at` | Account creation timestamp |
| `first_paid_at` | Canonical first paid purchase timestamp |
| `gclid` / `gbraid` / `wbraid` | Google Ads conversion feedback |
| `utm_*` | Campaign, ad, and keyword context |
| `competitor` | Conquest target selected/inferred |
| `plan` | Rapid, Builder, or Pro |
| `cta_location` | Conversion-placement analysis |
| `landing_variant` | Experiment assignment |
| `order_id` | Purchase deduplication |
| `revenue` / `currency` | Paid conversion value |

## QA acceptance test

Use one test click with a fake UTM and a test-only click ID. Confirm one continuous chain:

`landing event -> checkout URL -> registration row -> receipt/order -> Fabric attribution row -> GA4 purchase -> Google Ads paid conversion`

Release only when the same `mffu_csid` appears at every step and the purchase is deduplicated by `order_id`.
