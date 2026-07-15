(function () {
  "use strict";

  const LANDING_PAGE = "competitor_conquest";
  const LANDING_VARIANT = "conquest_v3";
  const OFFER_CODE = "300K";
  const ATTRIBUTION_KEYS = [
    "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
    "gclid", "gbraid", "wbraid", "msclkid", "ref"
  ];
  const COMPETITORS = [
    { name: "Topstep", terms: ["topstep", "top step"] },
    { name: "Apex Trader Funding", terms: ["apex trader funding", "apex funding", "apex trader", "apex"] },
    { name: "Tradeify", terms: ["tradeify"] },
    { name: "Take Profit Trader", terms: ["take profit trader", "takeprofittrader", "tpt"] },
    { name: "FundedNext", terms: ["fundednext", "funded next"] },
    { name: "Alpha Futures", terms: ["alpha futures"] },
    { name: "Lucid Trading", terms: ["lucid trading"] }
  ];

  const query = new URLSearchParams(window.location.search);
  const attributionContext = ATTRIBUTION_KEYS.reduce((context, key) => {
    const value = query.get(key);
    if (value) context[key] = value;
    return context;
  }, {});

  function safeStorage(storage, action, key, value) {
    try {
      return action === "get" ? storage.getItem(key) : storage.setItem(key, value);
    } catch {
      return null;
    }
  }

  function validId(value) {
    return typeof value === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(value) ? value : "";
  }

  function makeId(prefix) {
    const token = window.crypto && typeof window.crypto.randomUUID === "function"
      ? window.crypto.randomUUID().replace(/-/g, "")
      : Date.now().toString(36) + Math.random().toString(36).slice(2);
    return prefix + "_" + token;
  }

  function readCookie(name) {
    const prefix = encodeURIComponent(name) + "=";
    const part = document.cookie.split("; ").find((item) => item.startsWith(prefix));
    return part ? decodeURIComponent(part.slice(prefix.length)) : "";
  }

  function writeCookie(name, value, maxAge) {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    const host = window.location.hostname.toLowerCase();
    const domain = host === "myfundedfutures.com" || host.endsWith(".myfundedfutures.com")
      ? "; Domain=.myfundedfutures.com"
      : "";
    document.cookie = encodeURIComponent(name) + "=" + encodeURIComponent(value)
      + "; Path=/; Max-Age=" + maxAge + "; SameSite=Lax" + secure + domain;
  }

  const incomingSessionId = validId(query.get("mffu_csid"));
  const tabSessionId = validId(safeStorage(window.sessionStorage, "get", "mffu_csid"));
  const sessionId = incomingSessionId || tabSessionId || makeId("cq");
  safeStorage(window.sessionStorage, "set", "mffu_csid", sessionId);
  writeCookie("mffu_csid", sessionId, 60 * 60 * 24 * 30);

  const incomingVisitorId = validId(query.get("mffu_vid"));
  const storedVisitorId = validId(safeStorage(window.localStorage, "get", "mffu_vid"))
    || validId(readCookie("mffu_vid"));
  const visitorId = incomingVisitorId || storedVisitorId || makeId("v");
  safeStorage(window.localStorage, "set", "mffu_vid", visitorId);
  writeCookie("mffu_vid", visitorId, 60 * 60 * 24 * 365);

  window.dataLayer = window.dataLayer || [];
  let eventSequence = Number(safeStorage(window.sessionStorage, "get", "mffu_event_sequence")) || 0;

  function currentPlan() {
    const selected = document.querySelector('.plan-tab[aria-selected="true"]');
    return selected && selected.dataset.plan ? selected.dataset.plan : "rapid";
  }

  function currentCompetitor() {
    const select = document.getElementById("competitor");
    if (!select || select.value.toLowerCase().startsWith("another") || select.value === "another firm") return "";
    return select.value;
  }

  function pushEvent(eventName, details) {
    eventSequence += 1;
    safeStorage(window.sessionStorage, "set", "mffu_event_sequence", String(eventSequence));
    window.dataLayer.push(Object.assign({
      event: eventName,
      mffu_event_id: sessionId + "." + eventSequence,
      mffu_csid: sessionId,
      mffu_vid: visitorId,
      landing_page: LANDING_PAGE,
      landing_variant: LANDING_VARIANT,
      offer_code: OFFER_CODE,
      competitor: currentCompetitor() || "not_selected",
      plan: currentPlan(),
      page_path: window.location.pathname,
      page_referrer: document.referrer || "",
      event_time: new Date().toISOString()
    }, attributionContext, details || {}));
  }

  function inferCtaLocation(link) {
    if (link.dataset.ctaLocation) return link.dataset.ctaLocation;
    if (link.closest(".promo")) return "promo_bar";
    if (link.closest("header")) return "header";
    if (link.closest(".hero")) return "hero";
    if (link.closest(".plan-cta")) return "plan_panel";
    if (link.closest("#compare")) return "comparison";
    if (link.closest(".switch-band")) return "switch_band";
    if (link.closest(".sticky-mobile")) return "mobile_sticky";
    return "page";
  }

  function rewriteCheckoutLink(link) {
    const url = new URL(link.href, window.location.href);
    const plan = link.dataset.plan || currentPlan();
    const competitor = currentCompetitor();
    url.searchParams.set("mffu_csid", sessionId);
    url.searchParams.set("mffu_vid", visitorId);
    url.searchParams.set("landing_page", LANDING_PAGE);
    url.searchParams.set("landing_variant", LANDING_VARIANT);
    url.searchParams.set("offer", OFFER_CODE);
    url.searchParams.set("plan", plan);
    url.searchParams.set("cta", inferCtaLocation(link));
    if (competitor) url.searchParams.set("competitor", competitor);
    else url.searchParams.delete("competitor");
    ATTRIBUTION_KEYS.forEach((key) => {
      const value = query.get(key);
      if (value && !url.searchParams.has(key)) url.searchParams.set(key, value);
    });
    link.href = url.toString();
  }

  function rewriteAllCheckoutLinks() {
    document.querySelectorAll(".tracked-checkout").forEach(rewriteCheckoutLink);
  }

  function findCompetitor() {
    const signal = [
      query.get("competitor"), query.get("utm_term"), query.get("utm_content"), query.get("utm_campaign")
    ].filter(Boolean).join(" ").toLowerCase();
    if (!signal) return "";
    const match = COMPETITORS.find((item) => item.terms.some((term) => signal.includes(term)));
    return match ? match.name : "";
  }

  function personalizeHero(competitor) {
    const badge = document.getElementById("competitorBadge");
    const badgeName = document.getElementById("competitorName");
    const headline = document.getElementById("heroHeadline");
    const lede = document.getElementById("heroLede");
    if (!badge || !badgeName || !headline || !lede) return;

    if (competitor) {
      badge.hidden = false;
      badgeName.textContent = competitor;
      headline.innerHTML = "Comparing " + competitor + "? <span>See a cleaner path.</span>";
      lede.textContent = "Compare the rules that affect payouts and funded-account flexibility, then start with the MFFU plan built for how you trade.";
    } else {
      badge.hidden = true;
      badgeName.textContent = "";
      headline.innerHTML = "Stop paying for rules that <span>hold you back.</span>";
      lede.textContent = "Comparing another futures prop firm? Start with the rules that affect how you trade, then choose the MyFundedFutures path that fits you.";
    }
  }

  const competitorSelect = document.getElementById("competitor");
  const inferredCompetitor = findCompetitor();
  if (competitorSelect && inferredCompetitor) {
    competitorSelect.value = inferredCompetitor;
    competitorSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }
  personalizeHero(currentCompetitor());
  rewriteAllCheckoutLinks();

  document.querySelectorAll(".plan-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      rewriteAllCheckoutLinks();
      pushEvent("mffu_plan_selected", { plan: tab.dataset.plan || currentPlan() });
    });
  });

  if (competitorSelect) {
    competitorSelect.addEventListener("change", () => {
      personalizeHero(currentCompetitor());
      rewriteAllCheckoutLinks();
      pushEvent("mffu_competitor_selected");
    });
  }

  document.querySelectorAll(".tracked-checkout").forEach((link) => {
    link.addEventListener("click", () => {
      rewriteCheckoutLink(link);
      pushEvent("mffu_conquest_cta_click", {
        cta_location: inferCtaLocation(link),
        plan: link.dataset.plan || currentPlan(),
        destination: "challenge_checkout"
      });
    });
  });

  const copyButton = document.getElementById("copyCode");
  if (copyButton) copyButton.addEventListener("click", () => pushEvent("mffu_coupon_copy"));

  document.querySelectorAll('a[href*="rescue.html"]').forEach((link) => {
    link.addEventListener("click", () => pushEvent("mffu_rescue_click", { destination: "proof_rescue" }));
  });

  document.querySelectorAll("details").forEach((details, index) => {
    details.addEventListener("toggle", () => {
      if (details.open) pushEvent("mffu_faq_open", { faq_index: index + 1 });
    });
  });

  window.mffuAttribution = Object.freeze({
    sessionId: sessionId,
    visitorId: visitorId,
    landingPage: LANDING_PAGE,
    landingVariant: LANDING_VARIANT
  });

  pushEvent("mffu_conquest_view", {
    personalization: currentCompetitor() ? "competitor" : "generic",
    traffic_has_click_id: Boolean(query.get("gclid") || query.get("gbraid") || query.get("wbraid") || query.get("msclkid"))
  });
}());
