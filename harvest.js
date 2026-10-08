#!/usr/bin/env node
/**
 * Cyber Financial — CDR Home Loan Harvester
 * -----------------------------------------
 * Server-side nightly harvest of Australian home-loan Product Reference Data
 * from the Consumer Data Right (CDR) Open Banking APIs — banks AND non-bank
 * lenders. Runs with no CORS limits and full national coverage, then writes a
 * trimmed JSON the front-end reads instantly.
 *
 * v1.2 (Oct 2026): publishes brand display names instead of codes on shared endpoints;
 * flags rates published as the minimum or maximum of a range; retries rate-limited and
 * failed requests; refuses to publish a run that has collapsed against the last feed.
 * v1.1 (Oct 2026): harvests the register's "non-bank-lending" sector as well as
 * "banking"; prefers the register's productBaseUri; reads the nested fee layout
 * introduced by Get Product Detail v6; flags non-bank products (nbl) and records
 * each lender's sector; negotiates versions in one round trip with x-min-v.
 *
 * Requires Node 18+ (global fetch). No npm dependencies.
 *
 * Usage:
 *   node harvest.js                # full harvest -> ./public/products.json
 *   LIMIT=5 node harvest.js        # only first 5 lenders (testing)
 *   OUT=docs node harvest.js       # write to ./docs instead of ./public
 */
import { writeFile, mkdir, readFile } from "node:fs/promises";

const REGISTER = "https://api.cdr.gov.au/cdr-register/v1/all/data-holders/brands/summary";
/* Sectors harvested. The register tags each brand with one or more industries. Non-bank
   lenders (product data obligations from 13 Jul 2026) are tagged "non-bank-lending", NOT
   "banking" — but they serve the same /banking/products endpoints. Both are needed. */
const SECTORS = ["banking", "non-bank-lending"];
const OUT_DIR = process.env.OUT || "public";
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : 0;
const LENDER_CONCURRENCY = 5;
const DETAIL_CONCURRENCY = 6;
const REQ_TIMEOUT_MS = 20000;
const VERSION = "1.2.0";
const UA = "CyberFinancialHomeLoanHarvester/" + VERSION + " (+CDR PRD public data)";
/* Retry policy: a request that is rate-limited (429), hits a server error (5xx), times out or
   drops is retried with a growing pause, honouring Retry-After where the holder sends one. */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;
const RETRY_BASE_MS = process.env.RETRY_BASE_MS ? parseInt(process.env.RETRY_BASE_MS, 10) : 1000;
const RETRY_STATS = { retried: 0, recovered: 0 };
const DOWN = new Map();          // host -> consecutive exhausted failures; a holder that is plainly down stops being retried
const hostOf = u => { try { return new URL(u).host; } catch (e) { return u; } };
const canRetry = host => (DOWN.get(host) || 0) < 8;
const backoff = n => RETRY_BASE_MS * (n === 0 ? 1 : 3) + Math.floor(Math.random() * RETRY_BASE_MS * 0.4);
/* Safety net: FORCE=1 publishes even when a run is far smaller than the published feed. */
const FORCE = /^(1|true|yes)$/i.test(process.env.FORCE || "");
let USED_FALLBACK = false;

/* Built-in fallback list (used if the register call fails) */
const FALLBACK = [
  ["Commonwealth Bank","https://api.commbank.com.au/public/cds-au/v1"],
  ["Westpac","https://digital-api.westpac.com.au/cds-au/v1"],
  ["NAB","https://openbank.api.nab.com.au/cds-au/v1"],
  ["ANZ","https://api.anz/cds-au/v1"],
  ["Macquarie Bank","https://api.macquariebank.io/cds-au/v1"],
  ["ING","https://id.ob.ing.com.au/cds-au/v1"],
  ["Bankwest","https://open-api.bankwest.com.au/bwpublic/cds-au/v1"],
  ["St.George Bank","https://digital-api.stgeorge.com.au/cds-au/v1"],
  ["Bank of Melbourne","https://digital-api.bankofmelbourne.com.au/cds-au/v1"],
  ["BankSA","https://digital-api.banksa.com.au/cds-au/v1"],
  ["Suncorp Bank","https://id-ob.suncorpbank.com.au/cds-au/v1"],
  ["Bendigo Bank","https://api.cdr.bendigobank.com.au/cds-au/v1"],
  ["Bank of Queensland","https://api.cds.boq.com.au/cds-au/v1"],
  ["UBank","https://public.cdr-api.86400.com.au/cds-au/v1"],
  ["Unloan","https://public.api.cdr.unloan.com.au/cds-au/v1"],
  ["AMP","https://api.cdr-api.amp.com.au/cds-au/v1"],
  ["ME Bank","https://public.openbank.mebank.com.au/cds-au/v1"],
  ["Virgin Money","https://api.cds.virginmoney.com.au/cds-au/v1"],
  ["HSBC","https://public.ob.hsbc.com.au/cds-au/v1"],
  ["Great Southern Bank","https://api.open-banking.greatsouthernbank.com.au/cds-au/v1"]
].map(([name, base]) => ({ name, base }));

/* ---------- small utilities ---------- */
const num = v => { if (v == null || v === "") return null; const n = parseFloat(v); return isNaN(n) ? null : n; };
const lc = s => String(s || "").toLowerCase();
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Remembers the highest endpoint version each holder accepted, so a holder that rejects
   the first request is not re-negotiated on every later call (one detail call per product). */
const VERSION_MEMO = new Map();

async function getJSON(url, version, attemptsLeft, memoKey, retry) {
  // Negotiates the CDR endpoint version. Sends x-v (the highest version we can read) with
  // x-min-v: 1, which per the standard tells the holder to answer with the highest version
  // it supports in that range — one round trip. If a holder still answers 406 Not Acceptable
  // we fall back to stepping down (using the version it hints in x-v where given). This keeps
  // working as the standards raise versions (Get Products v5 / Get Product Detail v7, 13 Jul 2026).
  if (attemptsLeft == null) attemptsLeft = 8;
  retry = retry || 0;
  if (memoKey && VERSION_MEMO.has(memoKey)) version = Math.min(version, VERSION_MEMO.get(memoKey));
  const host = hostOf(url);
  const again = async waitMs => { RETRY_STATS.retried++; await sleep(waitMs); return getJSON(url, version, attemptsLeft, memoKey, retry + 1); };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(url, {
        headers: { "x-v": String(version), "x-min-v": "1", "Accept": "application/json", "User-Agent": UA },
        signal: ctrl.signal
      });
    } catch (e) {                                   // dropped connection or timeout
      clearTimeout(t);
      if (retry < MAX_RETRIES && canRetry(host)) return again(backoff(retry));
      DOWN.set(host, (DOWN.get(host) || 0) + 1);
      throw new Error(e && e.name === "AbortError" ? "timed out" : ((e && e.message) || "network error"));
    }
    if (res.status === 406 && attemptsLeft > 0 && version > 1) {
      clearTimeout(t);
      const hinted = parseInt(res.headers.get("x-v") || "", 10);
      const next = Math.max(1, (hinted && hinted < version) ? hinted : version - 1);
      if (memoKey) VERSION_MEMO.set(memoKey, next);
      return getJSON(url, next, attemptsLeft - 1, memoKey, retry);
    }
    if (RETRY_STATUS.has(res.status) && retry < MAX_RETRIES && canRetry(host)) {
      clearTimeout(t);
      const ra = parseFloat(res.headers.get("retry-after") || "");
      return again(ra > 0 ? Math.min(ra * 1000, 20000) : backoff(retry));
    }
    if (!res.ok) { DOWN.set(host, (DOWN.get(host) || 0) + 1); throw new Error("HTTP " + res.status); }
    const body = await res.json();
    if (retry) RETRY_STATS.recovered++;
    DOWN.delete(host);
    return body;
  } finally { clearTimeout(t); }
}

/* ---------- offering parsing (mirrors the front-end) ---------- */
function isoMonths(s){ if(!s) return null; const y=/(\d+)\s*Y/i.exec(s), m=/(\d+)\s*M/i.exec(s); let t=0; if(y)t+=+y[1]*12; if(m)t+=+m[1]; return t||null; }
function termLabel(s){ const mo=isoMonths(s); if(!mo) return "fixed"; return mo%12===0?(mo/12)+"yr":mo+"mo"; }
function rbucket(t){ t=(t||"").toUpperCase(); if(t==="FIXED") return "fixed"; if(["VARIABLE","INTRODUCTORY","DISCOUNT","FLOATING"].includes(t)) return "variable"; return "other"; }
function parseLVR(tiers){
  if(!Array.isArray(tiers)) return {min:null,max:null};
  for(const t of tiers){ if(lc(t.unitOfMeasure)==="percent"){ const norm=v=>{ v=num(v); return v==null?null:(v<=1?v*100:v); }; return {min:norm(t.minimumValue),max:norm(t.maximumValue)}; } }
  return {min:null,max:null};
}
/* Loads the previously published feed so this run can report what actually moved.
   In Actions the workspace is fresh, so the published Pages copy is the reliable
   source of "last run"; locally we fall back to whatever is already in OUT_DIR. */
async function loadPrevious(){
  const explicit = process.env.PREV_FEED_URL;
  const repo = process.env.GITHUB_REPOSITORY || "";
  const derived = repo.includes("/")
    ? `https://${repo.split("/")[0]}.github.io/${repo.split("/")[1]}/products.json`
    : null;
  const url = explicit || derived;
  if (url) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.ok) { const j = await res.json(); console.log(`  Previous feed loaded from ${url} (${j.productCount || 0} products)`); return j; }
      console.log(`  No previous feed at ${url} (HTTP ${res.status}) — first run, or not published yet`);
    } catch (e) { console.log(`  Could not read previous feed: ${e.message}`); }
  }
  try {
    const txt = await readFile(`${OUT_DIR}/products.json`, "utf8");
    const j = JSON.parse(txt);
    console.log(`  Previous feed loaded from ${OUT_DIR}/products.json`);
    return j;
  } catch (e) { return null; }
}
/* Best (lowest) published rate for a product — the figure the app ranks on. */
function bestRate(p){
  const rs = (p.offerings || []).map(o => o.rate).filter(v => v != null);
  return rs.length ? Math.min(...rs) : null;
}
/* Marks each product with its previous best rate when it has moved, and returns a digest. */
function diffRates(products, previous){
  const moves = [], summary = { moved: 0, down: 0, up: 0, added: 0, removed: 0, unchanged: 0 };
  if (!previous || !Array.isArray(previous.products)) return { moves, summary, previousAt: null };
  const prevMap = new Map();
  for (const p of previous.products) prevMap.set(p.id, bestRate(p));
  const seen = new Set();
  for (const p of products) {
    seen.add(p.id);
    const now = bestRate(p);
    if (!prevMap.has(p.id)) { summary.added++; continue; }
    const was = prevMap.get(p.id);
    if (was == null || now == null) continue;
    if (Math.abs(now - was) < 1e-9) { summary.unchanged++; continue; }
    p.prev = was;                                  // carried in the feed so the app needs no second request
    summary.moved++;
    if (now > was) summary.up++; else summary.down++;
    moves.push({ id: p.id, lender: p.lender, name: p.name, category: p.category,
                 from: was, to: now, delta: now - was });
  }
  for (const id of prevMap.keys()) if (!seen.has(id)) summary.removed++;
  moves.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { moves, summary, previousAt: previous.generatedAt || null };
}

/* Flags implausible published values. Nothing is silently discarded here: the point is
   visibility, so every finding is reported and written to meta.json for review. */
function validateProducts(products){
  const warnings=[], seenIds=new Map(), affected=new Set();
  const MAX_SANE=0.25;     // 25% p.a. — above this a home/personal rate is almost certainly wrong
  const MAX_COMP=0.35;
  for(const p of products){
    const tag=`${p.lender} / ${p.name || p.id}`;
    if(seenIds.has(p.id)){
      warnings.push(`duplicate product id ${p.id} (${tag} and ${seenIds.get(p.id)})`);
      affected.add(p.id);
    } else seenIds.set(p.id, tag);

    for(const o of (p.offerings||[])){
      if(o.rate!=null && o.rate>MAX_SANE){
        warnings.push(`${tag}: implausible rate ${(o.rate*100).toFixed(2)}%`); affected.add(p.id);
      }
      if(o.comp!=null && o.comp>MAX_COMP){
        warnings.push(`${tag}: implausible comparison rate ${(o.comp*100).toFixed(2)}%`); affected.add(p.id);
      }
      // A comparison rate includes fees, so it can equal the rate but should not sit below it.
      if(o.rate!=null && o.comp!=null && o.comp < o.rate - 0.0001){
        warnings.push(`${tag}: comparison rate ${(o.comp*100).toFixed(2)}% below headline ${(o.rate*100).toFixed(2)}%`);
        affected.add(p.id);
      }
    }
    if(!(p.offerings||[]).length && !p.isTailored && p.category!=="BUY_NOW_PAY_LATER"){
      warnings.push(`${tag}: no published rate and not flagged tailored`); affected.add(p.id);
    }
  }
  return { warnings, affected: affected.size };
}
/* Fee and discount amounts moved in Get Product Detail v6 (BankingProductFeeV2): the flat
   amount / balanceRate / transactionRate fields were replaced by a feeMethodUType with nested
   fixedAmount{amount} | rateBased{rateType,rate,amountRange} | variable{feeMinimum,feeMaximum}.
   Both layouts are read here so the feed carries one flat, stable shape. */
function mapFee(f){
  const fa = f.fixedAmount || {}, rb = f.rateBased || {}, vr = f.variable || {};
  const rbType = (rb.rateType || "").toUpperCase(), rbRate = rb.rate != null ? num(rb.rate) : null;
  const range = rb.amountRange || vr;
  const pick = (flat, nested) => flat != null ? num(flat) : (nested != null ? num(nested) : null);
  const feeType = (f.feeType || "").toUpperCase();   // PERIODIC / UPFRONT / EXIT / EVENT / TRANSACTION / WITHDRAWAL / DEPOSIT / ...
  return {
    name: f.name || f.feeType || "Fee",
    amount: pick(f.amount, fa.amount),
    balanceRate: pick(f.balanceRate, rbType === "BALANCE" ? rbRate : null),            // % of balance
    transactionRate: pick(f.transactionRate, rbType === "TRANSACTION" ? rbRate : null),
    accruedRate: pick(f.accruedRate, rbType === "INTEREST_ACCRUED" ? rbRate : null),
    min: range.feeMinimum != null ? num(range.feeMinimum) : null,                        // variable / ranged fees
    max: range.feeMaximum != null ? num(range.feeMaximum) : null,
    feeType,
    period: feeType === "PERIODIC" && f.additionalValue ? String(f.additionalValue).slice(0, 12) : null,   // ISO 8601 duration, e.g. P1M / P1Y
    /* Discounts attached to this fee — e.g. waived annual fee if packaged. */
    discounts: (f.discounts || []).slice(0, 6).map(x => {
      const xa = x.fixedAmount || {}, xr = x.rateBased || {};
      const xType = (xr.rateType || "").toUpperCase(), xRate = xr.rate != null ? num(xr.rate) : null;
      return {
        type: (x.discountType || "").toUpperCase(),                                      // BALANCE / DEPOSITS / PAYMENTS / FEE_CAP / ELIGIBILITY_ONLY
        amount: pick(x.amount, xa.amount),
        balanceRate: pick(x.balanceRate, xType === "BALANCE" ? xRate : null),
        feeRate: pick(x.feeRate, xType === "FEE" ? xRate : null),                        // share of the fee itself (1 = fully waived)
        otherRate: pick(x.transactionRate != null ? x.transactionRate : x.accruedRate, (xType === "TRANSACTION" || xType === "INTEREST_ACCRUED") ? xRate : null),
        info: (x.additionalInfo || x.description || "").slice(0, 100),
        eligibility: (x.eligibility || []).map(e => (e.discountEligibilityType || "")).filter(Boolean).slice(0, 4)
      };
    })
  };
}
/* Risk-priced lenders (mostly non-banks) publish a range rather than one rate: either a single
   rate noted as the minimum, or two rates noted as the minimum and maximum (CDR guidance,
   "Sharing product data in the non-bank lending sector"). The note lives in additionalInfo.
   Returns "min", "max" or null. Deliberately narrow so "minimum loan amount" is not caught. */
function rateBand(info){
  const s = lc(info);
  if (!s) return null;
  const q = "(?:interest |variable |fixed |comparison |advertised |indicative )?", pc = "\\s*\\d+(?:\\.\\d+)?\\s*%";
  if (new RegExp("\\b(?:maximum|max\\.?|highest) " + q + "rate\\b|\\b(?:maximum|upper|top)(?: end)? of (?:the |our )?(?:rate |interest rate )?range\\b|\\brates? (?:of )?up to" + pc).test(s)) return "max";
  if (new RegExp("\\b(?:minimum|min\\.?|lowest|starting) " + q + "rate\\b|\\b(?:minimum|lower|bottom)(?: end)? of (?:the |our )?(?:rate |interest rate )?range\\b|\\brates? (?:start(?:s|ing)? )?from" + pc + "|\\bstarting from" + pc).test(s)) return "min";
  return null;
}
function buildOfferings(detail){
  const offerings=[];
  const PAYABLE=["FIXED","VARIABLE","INTRODUCTORY","FLOATING","MARKET_LINKED"], RATE_FLOOR=0.005;
  for(const r of (detail.lendingRates||[])){
    let rate=num(r.rate); if(rate==null) continue;
    // A few holders publish percent-scale (5.89 meaning 5.89%) instead of the decimal
    // the standard expects. Display code copes, but RANKING compares raw numbers, so an
    // unnormalised 5.89 would sort as 589%. Normalise before any threshold test.
    if(rate>1) rate=rate/100;
    let comp=num(r.comparisonRate); if(comp!=null && comp>1) comp=comp/100;
    const RAW=(r.lendingRateType||"").toUpperCase();
    if(!PAYABLE.includes(RAW) || rate<RATE_FLOOR) continue;   // drop discount margins, penalty rates & interest-free assistance loans
    const rt=rbucket(r.lendingRateType); const lvr=parseLVR(r.tiers);
    const band=rateBand(r.additionalInfo);
    offerings.push({
      ...(band ? { band } : {}),
      // Passed through verbatim. From Get Product Detail v6 these can also be UNCONSTRAINED
      // ("applies to any") or OTHER; the app treats UNCONSTRAINED as a wildcard.
      purpose:(r.loanPurpose||"").toUpperCase()||null,
      repayment:(r.repaymentType||"").toUpperCase()||null,
      rtype:rt, raw:(r.lendingRateType||"").toUpperCase(),
      term: rt==="fixed"?termLabel(r.additionalValue):"",
      months: rt==="fixed"?isoMonths(r.additionalValue):null,
      rate, comp,
      lvrMin:lvr.min, lvrMax:lvr.max
    });
  }
  return offerings;
}

/* ---------- per-lender harvest ---------- */
async function getProducts(base){
  let url = base + "/banking/products?page-size=1000";
  const out = []; let guard = 0;
  while (url && guard < 8) {
    guard++;
    const json = await getJSON(url, 6, null, base + "|list");   // Get Products: current obligation is v5 (13 Jul 2026); ask above it and let the holder answer with its highest
    const list = (json.data && json.data.products) || [];
    out.push(...list);
    url = (json.links && json.links.next) || null;
  }
  return out;
}

async function harvestLender(lender){
  const result = { name: lender.name, base: lender.base, sector: lender.sector || "banking", status: "ok", productCount: 0, products: [] };
  let products;
  try {
    products = await getProducts(lender.base);
  } catch (e) {
    result.status = "fail"; result.error = e.message; return result;
  }
  result.listed = products.length;
  const catTally = {};
  for (const p of products) { const c = p.productCategory || "(none)"; catTally[c] = (catTally[c] || 0) + 1; }
  const COVERED = ["RESIDENTIAL_MORTGAGES", "PERS_LOANS", "BUY_NOW_PAY_LATER", "BUSINESS_LOANS", "OVERDRAFTS", "LEASES", "TRADE_FINANCE"];
  const mortgages = products.filter(p => COVERED.includes(p.productCategory));
  result.eligible = mortgages.length;
  // fetch detail with bounded concurrency
  let i = 0, detailFail = 0, detailErr = null;
  async function worker(){
    while (i < mortgages.length) {
      const p = mortgages[i++];
      try {
        const json = await getJSON(lender.base + "/banking/products/" + encodeURIComponent(p.productId), 8, null, lender.base + "|detail");   // Get Product Detail: current obligation is v7 (13 Jul 2026)
        const d = json.data || {};
        const offerings = buildOfferings(d);
        result.products.push({
          id: p.productId,
          lender: lender.name, ...(lender.sector === "non-bank-lending" ? { nbl: true } : {}), _brand: ((p.brand || p.brandName || "") + "").trim(), _brandName: ((p.brandName || "") + "").trim(),   // raw product brand code and display name; resolved endpoint-aware below
          name: p.name || "",
          description: (p.description || "").slice(0, 300),
          category: p.productCategory || "",
          isTailored: !!(d.isTailored || p.isTailored),
          constraints: (d.constraints || []).map(c => ({ type: c.constraintType || "", value: c.additionalValue != null ? String(c.additionalValue) : null, info: (c.additionalInfo || "").slice(0,120) })).slice(0, 8),
          lastUpdated: (d.lastUpdated || p.lastUpdated || "").slice(0, 10),
          applicationUri: d.applicationUri || (d.additionalInformation && (d.additionalInformation.overviewUri || "")) || "",
          basic: /\b(basic|no.?frills|essential|simplicity|simple|economy|budget|value)\b/.test(lc(p.name + " " + (p.description||""))),
          offerings,
          features: [...new Set((d.features || []).map(f => f.featureType).filter(Boolean))].slice(0, 20),
          fees: (d.fees || []).slice(0, 20).map(mapFee)
        });
      } catch (e) { detailFail++; if (!detailErr) detailErr = (e && e.message) || String(e); }
      await sleep(40); // politeness
    }
  }
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, mortgages.length) }, worker));
  result.productCount = result.products.length;
  /* Endpoint-aware brand labelling: use the per-product brand ONLY when this endpoint
     actually serves multiple distinct brands (shared group endpoints like the Westpac
     group). For single-brand endpoints use the register brand name, which avoids cryptic
     per-product codes (e.g. TMB, AMB, C, E) some holders put in the product `brand` field. */
  {
    const _brands = new Set(result.products.map(x => x._brand).filter(Boolean));
    const _multi = _brands.size > 1;
    /* On a shared endpoint prefer the brand's published display name ("Qantas Money") over its
       filter code ("QANTAS"). A name is only used when it belongs to exactly one code — a holder
       that puts its own name on every brand would otherwise merge them back together. The code
       is kept on the product so aliases written against codes still match. */
    const nameOf = new Map(), owners = new Map();
    for (const x of result.products) if (x._brand && x._brandName && !nameOf.has(x._brand)) nameOf.set(x._brand, x._brandName);
    for (const nm of nameOf.values()) owners.set(lc(nm), (owners.get(lc(nm)) || 0) + 1);
    for (const x of result.products) {
      let label = lender.name;
      if (_multi && x._brand) {
        const nm = nameOf.get(x._brand);
        label = (nm && owners.get(lc(nm)) === 1) ? nm : x._brand;
        if (label !== x._brand) x.code = x._brand;
      }
      x.lender = label; delete x._brand; delete x._brandName;
    }
  }
  result.detailFailed = detailFail;
  result.detailError = detailErr;
  if (result.productCount === 0) {
    if (result.listed === 0) result.emptyReason = "list returned 0 products";
    else if (result.eligible === 0) result.emptyReason = "no products in covered categories — endpoint returned: " + Object.keys(catTally).join(", ");
    else if (detailFail > 0) result.emptyReason = "all " + detailFail + " detail call(s) failed — e.g. " + (detailErr || "unknown");
    else result.emptyReason = "unknown";
  }
  return result;
}

/* ---------- discover lenders from register ---------- */
async function discover(){
  try {
    const json = await getJSON(REGISTER, 3);   // Get Data Holder Brands Summary: current version is v2
    const rows = json.data || [];
    const indsOf = b => (b.industries || (b.industry ? [b.industry] : [])).map(s => lc(s).replace(/[\s_]+/g, "-"));
    /* productBaseUri (register v2) is the dedicated product-data address; publicBaseUri is the
       general public address older entries carry. Prefer the former, fall back to the latter. */
    const uriOf = b => b.productBaseUri || b.publicBaseUri;
    const tally = {};
    for (const b of rows) for (const i of indsOf(b)) tally[i] = (tally[i] || 0) + 1;
    const lending = rows.filter(b => indsOf(b).some(i => SECTORS.includes(i)) && uriOf(b));
    const seen = new Map();
    const lenders = [];
    for (const b of lending) {
      const base = String(uriOf(b)).replace(/\/+$/, "") + "/cds-au/v1";
      const key = base.toLowerCase();
      const inds = indsOf(b);
      const sector = inds.includes("banking") ? "banking" : "non-bank-lending";
      if (seen.has(key)) {                       // several register brands sharing one endpoint
        const first = seen.get(key);
        if (b.brandName && !first.brands.includes(b.brandName)) first.brands.push(b.brandName);
        continue;
      }
      const rec = { name: b.brandName || "(unnamed)", base, sector, brands: [b.brandName || "(unnamed)"] };
      seen.set(key, rec); lenders.push(rec);
    }
    const nb = lenders.filter(l => l.sector === "non-bank-lending").length;
    console.log(`Register: ${rows.length} brands (${Object.keys(tally).sort().map(k => k + " " + tally[k]).join(", ") || "no industry tags"}).`);
    console.log(`Register: ${lenders.length} lending endpoints discovered — ${lenders.length - nb} banking, ${nb} non-bank lending.`);
    return lenders;
  } catch (e) {
    console.warn(`Register discovery failed (${e.message}). Using built-in fallback list.`);
    USED_FALLBACK = true;
    return FALLBACK.map(l => ({ ...l, sector: "banking", brands: [l.name] }));
  }
}

/* ---------- main ---------- */
async function main(){
  const started = Date.now();
  let lenders = await discover();
  if (LIMIT) lenders = lenders.slice(0, LIMIT);
  console.log(`Harvesting ${lenders.length} lenders…`);

  const lenderMeta = [];
  const allProducts = [];
  let q = 0;
  async function lenderWorker(){
    while (q < lenders.length) {
      const l = lenders[q++];
      const r = await harvestLender(l);
      lenderMeta.push({ name: r.name, base: r.base, sector: r.sector, sharedBrands: (l.brands && l.brands.length > 1) ? l.brands : null, status: r.status, error: r.error || null, productCount: r.productCount, listed: r.listed != null ? r.listed : null, eligible: r.eligible != null ? r.eligible : null, detailFailed: r.detailFailed || 0, detailError: r.detailError || null, emptyReason: r.emptyReason || null });
      allProducts.push(...r.products);
      if (r.status !== "ok") console.log(`  ✗ ${r.name} — ${r.error}`);
      else if (r.productCount === 0) console.log(`  ⚠ ${r.name} — 0 captured (listed ${r.listed}, eligible ${r.eligible}, detail-failed ${r.detailFailed})${r.emptyReason ? " — " + r.emptyReason : ""}`);
      else console.log(`  ✓ ${r.name} — ${r.productCount} products${r.sector === "non-bank-lending" ? " [non-bank]" : ""}${r.detailFailed ? " (" + r.detailFailed + " detail call(s) failed)" : ""}`);
    }
  }
  await Promise.all(Array.from({ length: LENDER_CONCURRENCY }, lenderWorker));

  allProducts.sort((a, b) => a.lender.localeCompare(b.lender) || a.name.localeCompare(b.name));

  // ---- Sanity checks: catch bad numbers here, not in front of a client ----
  const audit = validateProducts(allProducts);
  if (audit.warnings.length) {
    console.log(`\n  Data quality: ${audit.warnings.length} warning(s) across ${audit.affected} product(s)`);
    for (const w of audit.warnings.slice(0, 15)) console.log(`    ! ${w}`);
    if (audit.warnings.length > 15) console.log(`    … ${audit.warnings.length - 15} more (see meta.json)`);
  } else {
    console.log("\n  Data quality: no anomalies detected");
  }
  // ---- What moved since the last published run ----
  const previous = await loadPrevious();
  const diff = diffRates(allProducts, previous);
  if (diff.previousAt) {
    console.log(`  Rate changes since ${diff.previousAt.slice(0,10)}: ${diff.summary.moved} moved ` +
                `(${diff.summary.down} down, ${diff.summary.up} up), ${diff.summary.added} new, ${diff.summary.removed} gone`);
    for (const m of diff.moves.slice(0, 10)) {
      const dir = m.delta > 0 ? "up  " : "down";
      console.log(`    ${dir} ${(Math.abs(m.delta)*100).toFixed(2)}%  ${m.lender} — ${m.name} (${(m.from*100).toFixed(2)}% -> ${(m.to*100).toFixed(2)}%)`);
    }
    if (diff.moves.length > 10) console.log(`    … ${diff.moves.length - 10} more (see changes.json)`);
  }

  // ---- Safety net: never replace a good feed with a collapsed run ----
  const prevCount = (previous && previous.productCount) || 0;
  const prevOk = (previous && previous.lenderCount) || 0;
  const nowOk = lenderMeta.filter(l => l.status === "ok").length;
  const collapsed = [];
  if (!LIMIT && prevCount >= 300) {
    if (USED_FALLBACK) collapsed.push("the CDR register could not be reached, so only the built-in list of major banks was harvested");
    if (allProducts.length < prevCount * 0.6) collapsed.push(`only ${allProducts.length} products were captured against ${prevCount} in the published feed`);
    if (prevOk >= 20 && nowOk < prevOk * 0.6) collapsed.push(`only ${nowOk} lenders answered against ${prevOk} last time`);
  }
  if (RETRY_STATS.retried) console.log(`  Retries: ${RETRY_STATS.retried} request(s) retried, ${RETRY_STATS.recovered} recovered`);
  if (collapsed.length && !FORCE) {
    console.error(`\nNOT PUBLISHED — this run looks like a failure, not a real change:`);
    for (const c of collapsed) console.error(`  - ${c}`);
    console.error(`The published feed has been left as it was. Re-run later, or run with FORCE=1 (the "force" box on the manual run) if the smaller result is genuine.`);
    process.exitCode = 1;
    return;
  }
  if (collapsed.length) console.log(`  FORCE set — publishing despite: ${collapsed.join("; ")}`);

  const out = {
    generatedAt: new Date().toISOString(),
    harvester: VERSION,
    previousAt: diff.previousAt,
    lenderCount: lenderMeta.filter(l => l.status === "ok").length,
    productCount: allProducts.length,
    rateChanges: diff.summary,
    lenders: lenderMeta.sort((a, b) => a.name.localeCompare(b.name)),
    products: allProducts
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(`${OUT_DIR}/products.json`, JSON.stringify(out));
  // standalone movement digest for review / history
  await writeFile(`${OUT_DIR}/changes.json`, JSON.stringify({
    generatedAt: out.generatedAt, previousAt: diff.previousAt,
    summary: diff.summary, moves: diff.moves.slice(0, 500)
  }, null, 2));
  // also a tiny meta file for quick status checks
  await writeFile(`${OUT_DIR}/meta.json`, JSON.stringify({
    generatedAt: out.generatedAt, lenderCount: out.lenderCount, productCount: out.productCount,
    byCategory: allProducts.reduce((a,p)=>{ a[p.category]=(a[p.category]||0)+1; return a; }, {}),
    mortgageCount: allProducts.filter(p => p.category === "RESIDENTIAL_MORTGAGES").length,
    tailoredCount: allProducts.filter(p => p.isTailored).length,
    rateChanges: diff.summary,
    dataQuality: {
      warningCount: audit.warnings.length,
      productsAffected: audit.affected,
      warnings: audit.warnings.slice(0, 200)
    },
    staleness: (() => {
      const now = Date.now(), buckets = { under30d: 0, from30to90d: 0, over90d: 0, unknown: 0 };
      for (const p of allProducts) {
        const t = p.lastUpdated ? Date.parse(p.lastUpdated) : NaN;
        if (isNaN(t)) { buckets.unknown++; continue; }
        const d = (now - t) / 86400000;
        if (d < 30) buckets.under30d++; else if (d <= 90) buckets.from30to90d++; else buckets.over90d++;
      }
      return buckets;
    })(),
    bySector: lenderMeta.reduce((a, l) => { const k = l.sector || "banking"; a[k] = a[k] || { endpoints: 0, withProducts: 0, products: 0 }; a[k].endpoints++; if (l.productCount > 0) a[k].withProducts++; a[k].products += l.productCount || 0; return a; }, {}),
    harvester: VERSION,
    retries: { retried: RETRY_STATS.retried, recovered: RETRY_STATS.recovered },
    rangePriced: allProducts.filter(p => (p.offerings || []).some(o => o.band)).length,
    feesWithAmount: allProducts.reduce((n, p) => n + (p.fees || []).filter(f => f.amount != null).length, 0),
    feesTotal: allProducts.reduce((n, p) => n + (p.fees || []).length, 0),
    lenders: out.lenders.map(l => ({ name: l.name, base: l.base, sector: l.sector, sharedBrands: l.sharedBrands, status: l.status, error: l.error, productCount: l.productCount, listed: l.listed, eligible: l.eligible, detailFailed: l.detailFailed, detailError: l.detailError, emptyReason: l.emptyReason }))
  }, null, 2));

  const ok = lenderMeta.filter(l => l.status === "ok").length;
  const failed = lenderMeta.length - ok;
  const nbOk = lenderMeta.filter(l => l.sector === "non-bank-lending" && l.productCount > 0);
  console.log(`  Non-bank lending: ${nbOk.length} endpoint(s) returned products${nbOk.length ? " — " + nbOk.map(l => l.name).slice(0, 40).join(", ") : ""}`);
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s — ${out.productCount} products from ${ok} lenders (${failed} failed). Wrote ${OUT_DIR}/products.json`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
