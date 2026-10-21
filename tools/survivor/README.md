# Survivor intake

Public route: https://failedtofunded.com/survivor

This static frontend is isolated from the existing homepage, tracking scripts, coupons, and switch program. It uses a separate report database, not the marketing or rescue intake. No automatic emails are sent.

## Rebuild

From this directory, run `npm ci` and `npm run build`. Generated pages and hashed assets in `../../survivor` are committed because the Render static service has no build command. Only commit the source, lockfile, and generated public assets, never local runtime credentials.

The initial frontend source was copied from the Vest Slippage Sites project using `node sync-from-sites.mjs ABSOLUTE_SITES_CHECKOUT`. That command verifies `.openai/hosting.json` matches `appgprj_6ad7e6b8b5b08191a1983856c0529f7a`. When updating the collection's shared wording, sync the revised source before rebuilding.

## Report backend

Endpoint: `https://vest-slippage.lukejacobi.chatgpt.site/api/reports`.

The existing Sites project holds reports in Cloudflare D1. Its source remote is `https://git.chatgpt-team.site/ae296bd0-2abf-4ecf-aeed-41f7ed82735f/appgprj_6ad7e6b8b5b08191a1983856c0529f7a.git`. It accepts JSON writes from its own origin and the exact Failed to Funded production origins. Browser requests omit credentials. Server validation, consent, request size limits, rate limits, and idempotency remain enforced. The backend stores only a hash of each withdrawal token.

The `/organizer` page on the Sites host requires the specifically authorized ChatGPT account. Public visitors cannot export reports. No admin credentials or authentication bypass token belong in this repository.

## Publication and checks

Publishing was requested by Luke on October 20, 2026 for `/survivor`. Failed to Funded's current operator identity and privacy contact are used, with a visible competing-provider disclosure. Allegations are distinguished from verified findings. This page does not claim independent verification of the user's allegation.

Verify the live page and hashed assets, a synthetic submission and deletion, denied unauthorized export, blocked unrelated origins, required consent, and no horizontal overflow on mobile. Delete test records after verification. Preserve the homepage and rescue routes.
