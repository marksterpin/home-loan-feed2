#!/usr/bin/env node
/**
 * Cyber Financial — CDR Home Loan Harvester
 * -----------------------------------------
 * Server-side nightly harvest of Australian home-loan Product Reference Data
 * from the Consumer Data Right (CDR) Open Banking APIs. Runs with no CORS
 * limits and full national coverage, then writes a trimmed JSON the
 * front-end reads instantly.
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
const OUT_DIR = process.env.OUT || "public";
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : 0;
const LENDER_CONCURRENCY = 5;
const DETAIL_CONCURRENCY = 6;
const REQ_TIMEOUT_MS = 20000;
const UA = "CyberFinancialHomeLoanHarvester/1.0 (+CDR PRD public data)";

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

async function getJSON(url, version, attemptsLeft) {
  // Negotiates the CDR endpoint version. Starts at the given (high) version and,
  // on a 406 Not Acceptable, retries using the highest version the holder advertises
  // in the response x-v header, otherwise steps down one version. This keeps working
  // as the standards raise versions (e.g. Get Products v4 -> v5 from 13 Jul 2026).
  if (attemptsLeft == null) attemptsLeft = 8;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "x-v": String(version), "Accept": "application/json", "User-Agent": UA },
      signal: ctrl.signal
    });
    if (res.status === 406 && attemptsLeft > 0 && version > 1) {
      clearTimeout(t);
      const hinted = parseInt(res.headers.get("x-v") || "", 10);
      const next = (hinted && hinted !== version) ? hinted : version - 1;
      return getJSON(url, Math.max(1, next), attemptsLeft - 1);
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
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
    offerings.push({
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
    const json = await getJSON(url, 6);   // Get Products: current obligation is v5 (13 Jul 2026); start above and negotiate down
    const list = (json.data && json.data.products) || [];
    out.push(...list);
    url = (json.links && json.links.next) || null;
  }
  return out;
}

async function harvestLender(lender){
  const result = { name: lender.name, base: lender.base, status: "ok", productCount: 0, products: [] };
  let products;
  try {
    products = await getProducts(lender.base);
  } catch (e) {
    result.status = "fail"; result.error = e.message; return result;
  }
  const COVERED = ["RESIDENTIAL_MORTGAGES", "PERS_LOANS", "BUY_NOW_PAY_LATER", "BUSINESS_LOANS", "OVERDRAFTS", "LEASES", "TRADE_FINANCE"];
  const mortgages = products.filter(p => COVERED.includes(p.productCategory));
  // fetch detail with bounded concurrency
  let i = 0;
  async function worker(){
    while (i < mortgages.length) {
      const p = mortgages[i++];
      try {
        const json = await getJSON(lender.base + "/banking/products/" + encodeURIComponent(p.productId), 8);   // Get Product Detail: current obligation is v7 (13 Jul 2026)
        const d = json.data || {};
        const offerings = buildOfferings(d);
        result.products.push({
          id: p.productId,
          lender: lender.name,
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
          fees: (d.fees || []).slice(0, 15).map(f => ({ name: f.name || f.feeType || "Fee", amount: f.amount != null ? String(f.amount) : null, rate: f.rate != null ? num(f.rate) : null, feeType: f.feeType || "" }))
        });
      } catch (e) { /* skip individual product errors */ }
      await sleep(40); // politeness
    }
  }
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, mortgages.length) }, worker));
  result.productCount = result.products.length;
  return result;
}

/* ---------- discover lenders from register ---------- */
async function discover(){
  try {
    const json = await getJSON(REGISTER, 3);
    const rows = json.data || [];
    const banking = rows.filter(b => {
      const inds = (b.industries || (b.industry ? [b.industry] : [])).map(lc);
      return inds.includes("banking") && b.publicBaseUri;
    });
    const seen = new Set();
    const lenders = [];
    for (const b of banking) {
      const base = String(b.publicBaseUri).replace(/\/+$/, "") + "/cds-au/v1";
      const key = base.toLowerCase();
      if (seen.has(key)) continue; seen.add(key);
      lenders.push({ name: b.brandName || "(unnamed)", base });
    }
    console.log(`Register: ${lenders.length} banking brands discovered.`);
    return lenders;
  } catch (e) {
    console.warn(`Register discovery failed (${e.message}). Using built-in fallback list.`);
    return FALLBACK.slice();
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
      lenderMeta.push({ name: r.name, base: r.base, status: r.status, error: r.error || null, productCount: r.productCount });
      allProducts.push(...r.products);
      console.log(`  ${r.status === "ok" ? "✓" : "✗"} ${r.name} — ${r.status === "ok" ? r.productCount + " mortgages" : r.error}`);
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

  const out = {
    generatedAt: new Date().toISOString(),
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
    lenders: out.lenders.map(l => ({ name: l.name, status: l.status, error: l.error, productCount: l.productCount }))
  }, null, 2));

  const ok = lenderMeta.filter(l => l.status === "ok").length;
  const failed = lenderMeta.length - ok;
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s — ${out.productCount} products from ${ok} lenders (${failed} failed). Wrote ${OUT_DIR}/products.json`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
