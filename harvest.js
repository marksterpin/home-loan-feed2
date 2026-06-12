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
import { writeFile, mkdir } from "node:fs/promises";

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

async function getJSON(url, version) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "x-v": String(version), "Accept": "application/json", "User-Agent": UA },
      signal: ctrl.signal
    });
    if (res.status === 406 && version > 1) { clearTimeout(t); return getJSON(url, version - 1); }
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
function buildOfferings(detail){
  const offerings=[];
  for(const r of (detail.lendingRates||[])){
    const rate=num(r.rate); if(rate==null) continue;
    const rt=rbucket(r.lendingRateType); const lvr=parseLVR(r.tiers);
    offerings.push({
      purpose:(r.loanPurpose||"").toUpperCase()||null,
      repayment:(r.repaymentType||"").toUpperCase()||null,
      rtype:rt, raw:(r.lendingRateType||"").toUpperCase(),
      term: rt==="fixed"?termLabel(r.additionalValue):"",
      months: rt==="fixed"?isoMonths(r.additionalValue):null,
      rate, comp:num(r.comparisonRate),
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
    const json = await getJSON(url, 3);
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
  const mortgages = products.filter(p => p.productCategory === "RESIDENTIAL_MORTGAGES");
  // fetch detail with bounded concurrency
  let i = 0;
  async function worker(){
    while (i < mortgages.length) {
      const p = mortgages[i++];
      try {
        const json = await getJSON(lender.base + "/banking/products/" + encodeURIComponent(p.productId), 4);
        const d = json.data || {};
        const offerings = buildOfferings(d);
        result.products.push({
          id: p.productId,
          lender: lender.name,
          name: p.name || "",
          description: (p.description || "").slice(0, 300),
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
    const json = await getJSON(REGISTER, 2);
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
  const out = {
    generatedAt: new Date().toISOString(),
    lenderCount: lenderMeta.filter(l => l.status === "ok").length,
    productCount: allProducts.length,
    lenders: lenderMeta.sort((a, b) => a.name.localeCompare(b.name)),
    products: allProducts
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(`${OUT_DIR}/products.json`, JSON.stringify(out));
  // also a tiny meta file for quick status checks
  await writeFile(`${OUT_DIR}/meta.json`, JSON.stringify({
    generatedAt: out.generatedAt, lenderCount: out.lenderCount, productCount: out.productCount,
    lenders: out.lenders.map(l => ({ name: l.name, status: l.status, productCount: l.productCount }))
  }, null, 2));

  const ok = lenderMeta.filter(l => l.status === "ok").length;
  const failed = lenderMeta.length - ok;
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s — ${out.productCount} products from ${ok} lenders (${failed} failed). Wrote ${OUT_DIR}/products.json`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
