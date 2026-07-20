(function () {
  "use strict";

  const OFFER_CODE = "300K";
  const DEADLINE_MS = Date.parse("2026-08-01T03:59:59Z");
  const LANDING_PAGE = "300k_offer";
  const LANDING_VARIANT = "300k_v5";
  const ATTRIBUTION_KEYS = [
    "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
    "gclid", "gbraid", "wbraid", "msclkid", "ref"
  ];
  const PLANS = {
    rapid: {
      id: "70",
      name: "Rapid",
      title: "Rapid: built for payout speed.",
      cta: "Get Rapid 50% Off",
      context: "Daily payout requests. No daily loss limit on funded accounts. No consistency rule."
    },
    pro: {
      id: "48",
      name: "Pro",
      title: "Pro: built for flexibility.",
      cta: "Get Pro 50% Off",
      context: "More funded-account flexibility. No daily loss limit. Up to 90% of simulated profits."
    },
    builder: {
      id: "84",
      name: "Builder 50K",
      title: "Builder 50K: built for structure.",
      cta: "Get Builder 50K 50% Off",
      context: "A structured evaluation path. Builder 50K only for this offer. $0 activation fee."
    }
  };

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
  const tabSessionId = validId(safeStorage(window.sessionStorage, "get", "mffu_300k_csid"));
  const sessionId = incomingSessionId || tabSessionId || makeId("p300");
  safeStorage(window.sessionStorage, "set", "mffu_300k_csid", sessionId);
  writeCookie("mffu_csid", sessionId, 60 * 60 * 24 * 30);

  const incomingVisitorId = validId(query.get("mffu_vid"));
  const storedVisitorId = validId(safeStorage(window.localStorage, "get", "mffu_vid"))
    || validId(readCookie("mffu_vid"));
  const visitorId = incomingVisitorId || storedVisitorId || makeId("v");
  safeStorage(window.localStorage, "set", "mffu_vid", visitorId);
  writeCookie("mffu_vid", visitorId, 60 * 60 * 24 * 365);

  let eventSequence = Number(safeStorage(window.sessionStorage, "get", "mffu_300k_event_sequence")) || 0;
  let activePlan = inferPlan();
  let offerExpired = Date.now() > DEADLINE_MS;
  window.dataLayer = window.dataLayer || [];

  function inferPlan() {
    const signal = [
      query.get("plan"),
      query.get("intent"),
      query.get("utm_content"),
      query.get("utm_term"),
      query.get("utm_campaign")
    ].filter(Boolean).join(" ").toLowerCase();
    if (signal.includes("builder")) return "builder";
    if (signal.includes("pro") && !signal.includes("promo")) return "pro";
    if (signal.includes("rapid")) return "rapid";
    return "rapid";
  }

  function pushEvent(eventName, details) {
    eventSequence += 1;
    safeStorage(window.sessionStorage, "set", "mffu_300k_event_sequence", String(eventSequence));
    window.dataLayer.push(Object.assign({
      event: eventName,
      mffu_event_id: sessionId + "." + eventSequence,
      mffu_csid: sessionId,
      mffu_vid: visitorId,
      landing_page: LANDING_PAGE,
      landing_variant: LANDING_VARIANT,
      offer_code: OFFER_CODE,
      offer_status: offerExpired ? "expired" : "active",
      plan: activePlan,
      page_path: window.location.pathname,
      page_referrer: document.referrer || "",
      event_time: new Date().toISOString()
    }, attributionContext, details || {}));
  }

  function checkoutUrl(plan, ctaLocation) {
    if (offerExpired) {
      const expiredUrl = new URL("https://myfundedfutures.com/coupons");
      expiredUrl.searchParams.set("utm_source", query.get("utm_source") || "300k_landing_page");
      expiredUrl.searchParams.set("utm_medium", query.get("utm_medium") || "expired_offer");
      expiredUrl.searchParams.set("utm_campaign", query.get("utm_campaign") || "300k_promo");
      expiredUrl.searchParams.set("mffu_csid", sessionId);
      expiredUrl.searchParams.set("mffu_vid", visitorId);
      return expiredUrl.toString();
    }

    const config = PLANS[plan] || PLANS.rapid;
    const url = new URL("https://myfundedfutures.com/challenge");
    url.searchParams.set("coupon", OFFER_CODE.toLowerCase());
    url.searchParams.set("id", config.id);
    ATTRIBUTION_KEYS.forEach((key) => {
      const value = query.get(key);
      if (value) url.searchParams.set(key, value);
    });
    if (!url.searchParams.has("utm_source")) url.searchParams.set("utm_source", "300k_landing_page");
    if (!url.searchParams.has("utm_medium")) url.searchParams.set("utm_medium", "promo");
    if (!url.searchParams.has("utm_campaign")) url.searchParams.set("utm_campaign", "300k_promo");
    if (!url.searchParams.has("utm_content")) url.searchParams.set("utm_content", "300K_" + plan);
    url.searchParams.set("mffu_csid", sessionId);
    url.searchParams.set("mffu_vid", visitorId);
    url.searchParams.set("landing_page", LANDING_PAGE);
    url.searchParams.set("landing_variant", LANDING_VARIANT);
    url.searchParams.set("offer", OFFER_CODE);
    url.searchParams.set("plan", plan);
    url.searchParams.set("cta", ctaLocation || "page");
    return url.toString();
  }

  function rewriteLinks() {
    document.querySelectorAll(".tracked-checkout").forEach((link) => {
      const plan = link.dataset.plan || activePlan;
      link.href = checkoutUrl(plan, link.dataset.ctaLocation || "page");
      if (offerExpired) link.textContent = "See Current Offers";
    });
  }

  function selectPlan(plan, emitEvent) {
    if (!PLANS[plan]) return;
    activePlan = plan;
    document.querySelectorAll("[data-follow-active]").forEach((link) => {
      link.dataset.plan = plan;
      if (link.dataset.ctaLocation === "final_cta") link.textContent = PLANS[plan].cta;
    });
    document.querySelectorAll(".plan-switch").forEach((button) => {
      const active = button.dataset.plan === plan;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });
    const context = document.getElementById("planContext");
    const contextTitle = document.getElementById("planContextTitle");
    const heroCta = document.getElementById("heroCta");
    if (contextTitle) contextTitle.textContent = PLANS[plan].title;
    if (context) context.textContent = PLANS[plan].context;
    if (heroCta) {
      heroCta.dataset.plan = plan;
      heroCta.textContent = offerExpired ? "See Current Offers" : PLANS[plan].cta;
    }
    rewriteLinks();
    if (emitEvent) pushEvent("mffu_300k_plan_selected", { plan: plan });
  }

  function setCountdownPart(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value).padStart(2, "0");
  }

  function expireOffer() {
    if (offerExpired && document.body.classList.contains("offer-expired")) return;
    offerExpired = true;
    document.body.classList.add("offer-expired");
    const promoMessage = document.getElementById("promoMessage");
    if (promoMessage) promoMessage.textContent = "The 300K promotion has ended.";
    const headline = document.getElementById("heroHeadline");
    const lede = document.getElementById("heroLede");
    if (headline) headline.textContent = "The 300K promotion has ended.";
    if (lede) lede.textContent = "See the current MyFundedFutures offers before choosing your next evaluation.";
    document.querySelectorAll("[data-copy-code]").forEach((button) => {
      button.disabled = true;
      button.textContent = "Offer ended";
    });
    const label = document.querySelector(".countdown-label");
    if (label) label.textContent = "OFFER ENDED";
    setCountdownPart("days", 0);
    setCountdownPart("hours", 0);
    setCountdownPart("minutes", 0);
    setCountdownPart("seconds", 0);
    rewriteLinks();
  }

  function updateCountdown() {
    const remaining = DEADLINE_MS - Date.now();
    if (remaining <= 0) {
      expireOffer();
      return;
    }
    const totalSeconds = Math.floor(remaining / 1000);
    setCountdownPart("days", Math.floor(totalSeconds / 86400));
    setCountdownPart("hours", Math.floor((totalSeconds % 86400) / 3600));
    setCountdownPart("minutes", Math.floor((totalSeconds % 3600) / 60));
    setCountdownPart("seconds", totalSeconds % 60);
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(OFFER_CODE);
    } catch {
      const input = document.createElement("input");
      input.value = OFFER_CODE;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    const toast = document.getElementById("toast");
    if (toast) {
      toast.classList.add("show");
      window.setTimeout(() => toast.classList.remove("show"), 1600);
    }
    pushEvent("mffu_300k_coupon_copy");
  }

  document.querySelectorAll(".plan-switch").forEach((button) => {
    button.addEventListener("click", () => selectPlan(button.dataset.plan, true));
  });

  document.querySelectorAll("[data-copy-code]").forEach((button) => {
    button.addEventListener("click", copyCode);
  });

  document.querySelectorAll(".tracked-checkout").forEach((link) => {
    link.addEventListener("click", () => {
      const plan = link.dataset.plan || activePlan;
      link.href = checkoutUrl(plan, link.dataset.ctaLocation || "page");
      pushEvent("mffu_300k_cta_click", {
        plan: plan,
        cta_location: link.dataset.ctaLocation || "page",
        destination: offerExpired ? "current_offers" : "challenge_checkout"
      });
    });
  });

  document.querySelectorAll("details").forEach((details, index) => {
    details.addEventListener("toggle", () => {
      if (details.open) pushEvent("mffu_300k_faq_open", { faq_index: index + 1 });
    });
  });

  const sticky = document.getElementById("stickyOffer");
  const heroCta = document.getElementById("heroCta");
  if (sticky && heroCta && "IntersectionObserver" in window) {
    const observer = new IntersectionObserver(([entry]) => {
      sticky.classList.toggle("is-visible", !entry.isIntersecting);
    }, { threshold: .15 });
    observer.observe(heroCta);
  }

  selectPlan(activePlan, false);
  updateCountdown();
  window.setInterval(updateCountdown, 1000);

  window.mffuAttribution = Object.freeze({
    sessionId: sessionId,
    visitorId: visitorId,
    landingPage: LANDING_PAGE,
    landingVariant: LANDING_VARIANT,
    plan: activePlan
  });

  pushEvent(offerExpired ? "mffu_300k_expired_view" : "mffu_300k_view", {
    inferred_plan: activePlan,
    traffic_has_click_id: Boolean(query.get("gclid") || query.get("gbraid") || query.get("wbraid") || query.get("msclkid"))
  });
}());
