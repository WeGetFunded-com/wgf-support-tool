#!/usr/bin/env tsx
/**
 * READ-ONLY simulator: current zipf model vs V3 adaptive bot-wall.
 * Reuses the wgf-support-shell tunnel (.env). No writes, no deploy.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

// ---- locked V3 knobs ----
const TARGET_MARGIN = 0.85;     // house keeps >= 85% of real fees
const WALL_MULT = 1.06;         // top shark = best_real * 1.06
const MIN_BOT_TOP_RANKS = 3;    // reals never top 3
// zipf structure (prod): single band [0,0.15), exponent 0.8, share 1.0
const BAND = { from: 0, to: 0.15, exp: 0.8 };

const SUPPORT = "/Users/cyrilsalvi/Documents/WGF/wgf-support-shell";

function findFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, () => { const a = s.address(); if (a && typeof a === "object") { const p = a.port; s.close(() => res(p)); } else { s.close(() => rej(new Error("no port"))); } });
    s.on("error", rej);
  });
}
function waitForPort(port: number, ms: number): Promise<void> {
  return new Promise((res, rej) => { const dl = Date.now() + ms; (function t() { if (Date.now() > dl) return rej(new Error("tunnel timeout")); const sk = createConnection({ port, host: "127.0.0.1" }, () => { sk.destroy(); res(); }); sk.on("error", () => setTimeout(t, 300)); })(); });
}

// ---- zipf single-band distribute (faithful to contest_prize.go) ----
function distribute(pool: number, feesRanked: number[]): number[] {
  const n = feesRanked.length;
  const prizes = new Array(n).fill(0);
  if (n === 0 || pool <= 0) return prizes;
  const members: number[] = [];
  for (let i = 0; i < n; i++) { const pct = i / n; if (pct >= BAND.from && pct < BAND.to) members.push(i); }
  const amount = pool * 1.0;
  let sumW = 0; const w: number[] = [];
  for (let k = 0; k < members.length; k++) { const ww = Math.pow(k + 1, -BAND.exp); w.push(ww); sumW += ww; }
  for (let k = 0; k < members.length; k++) prizes[members[k]] = (amount * w[k]) / sumW;
  return prizes;
}

type Row = { ret: number; fee: number; isBot: boolean; eligible: boolean };

function rankOrganic(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => (a.ret !== b.ret ? b.ret - a.ret : (!a.isBot && b.isBot ? -1 : 1)));
}
function realPrizeSum(ranked: Row[], pool: number): number {
  const elig = ranked.filter(r => r.eligible);
  const prizes = distribute(pool, elig.map(r => r.fee));
  let s = 0; elig.forEach((r, i) => { if (!r.isBot) s += prizes[i]; });
  return s;
}

// V3 wall: minimal d>=3 top bots lifted above all reals so realPrize<=B.
function applyWall(rows: Row[], pool: number, B: number) {
  const bots = rows.filter(r => r.isBot).sort((a, b) => b.ret - a.ret);
  const maxD = bots.length;
  for (let d = MIN_BOT_TOP_RANKS; d <= maxD; d++) {
    const sharks = bots.slice(0, d);
    const rest = rows.filter(r => !sharks.includes(r));
    const ranked = [...sharks].concat(rankOrganic(rest)); // sharks always on top
    const rp = realPrizeSum(ranked, pool);
    if (rp <= B + 1e-9) return { d, ranked, realPrize: rp };
  }
  // fallback: all bots on top
  const ranked = bots.concat(rankOrganic(rows.filter(r => !r.isBot)));
  return { d: maxD, ranked, realPrize: realPrizeSum(ranked, pool) };
}

async function main() {
  const env = dotenv.parse(readFileSync(join(SUPPORT, ".env"), "utf-8"));
  const pfx = "STAGING";
  const localPort = await findFreePort();
  const child: ChildProcess = spawn("kubectl", [
    `--server=${env.KUBE_SERVER}`, `--token=${env.KUBE_TOKEN}`, "--insecure-skip-tls-verify",
    "port-forward", `pod/${env[`${pfx}_POD_NAME`]}`, `${localPort}:${env[`${pfx}_POD_PORT`]}`,
    "-n", env[`${pfx}_NAMESPACE`],
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let serr = ""; child.stderr?.on("data", d => serr += d);
  await Promise.race([waitForPort(localPort, 15000), new Promise((_, rej) => child.on("exit", c => c && rej(new Error("tunnel: " + serr))))]);

  const cn = await mysql.createConnection({ host: "127.0.0.1", port: localPort, user: env[`${pfx}_DB_USER`], password: env[`${pfx}_DB_PASSWORD`], database: env[`${pfx}_DB_NAME`], ssl: { rejectUnauthorized: false } });

  // editions that have at least one real entry, settled with results
  const [eds]: any = await cn.execute(`
    SELECT LOWER(HEX(e.edition_uuid)) id, e.cadence, e.status,
           e.guaranteed_min gm, e.entries_amount ea, e.final_pool fp
    FROM contest_edition e
    WHERE e.edition_uuid IN (SELECT DISTINCT edition_uuid FROM contest_entry)
    ORDER BY e.starts_at DESC`);

  console.log(`\n=== V3 BOT-WALL SIM — margin ${TARGET_MARGIN * 100}%, mult x${WALL_MULT}, top${MIN_BOT_TOP_RANKS} bots ===`);
  let totCurProfit = 0, totV3Profit = 0, totFees = 0;
  for (const e of eds) {
    const id = e.id;
    const [ents]: any = await cn.execute(
      `SELECT final_return_pct ret, entry_fee fee, status FROM contest_entry WHERE edition_uuid=UNHEX(?)`, [id]);
    const [bots]: any = await cn.execute(
      `SELECT final_return_pct ret, notional_fee fee, status FROM contest_bot WHERE edition_uuid=UNHEX(?)`, [id]);

    const pool = e.status === "settled" && e.fp != null ? Number(e.fp) : Math.max(Number(e.gm), 0.89 * Number(e.ea));
    const rows: Row[] = [];
    let realFees = 0; let realCount = 0; let realEligible = 0;
    for (const r of ents) {
      const ret = r.ret == null ? null : Number(r.ret);
      realFees += Number(r.fee); realCount++;
      if (ret == null) continue; // not settled -> skip from ranking
      const elig = ret !== 0; rows.push({ ret, fee: Number(r.fee), isBot: false, eligible: elig });
      if (elig) realEligible++;
    }
    for (const b of bots) {
      const ret = b.ret == null ? null : Number(b.ret);
      if (ret == null) continue;
      rows.push({ ret, fee: Number(b.fee), isBot: true, eligible: ret !== 0 });
    }
    if (rows.length === 0) continue;

    // CURRENT model
    const curRanked = rankOrganic(rows);
    const curReal = realPrizeSum(curRanked, pool);
    const curProfit = realFees - curReal;
    const bestReal = Math.max(...rows.filter(r => !r.isBot && r.eligible).map(r => r.ret), -Infinity);
    const realRankCur = curRanked.findIndex(r => !r.isBot && r.ret === bestReal) + 1;

    // V3
    const B = (1 - TARGET_MARGIN) * realFees;
    const w = applyWall(rows, pool, B);
    const v3Profit = realFees - w.realPrize;
    const realRankV3 = w.ranked.findIndex(r => !r.isBot && r.ret === bestReal) + 1;

    totCurProfit += curProfit; totV3Profit += v3Profit; totFees += realFees;
    console.log(
      `\n[${e.cadence} ${e.status}] pool=${pool.toFixed(0)}€  reals=${realCount}(elig ${realEligible}) fees=${realFees}€  bestReal=${bestReal === -Infinity ? "-" : (bestReal * 100).toFixed(1) + "%"}`);
    console.log(
      `  CURRENT: bestReal rank #${realRankCur || "-"}  -> real payout ${curReal.toFixed(2)}€  | profit ${curProfit.toFixed(2)}€`);
    console.log(
      `  V3 WALL: wall depth d=${w.d}  bestReal rank #${realRankV3 || "out"}  B=${B.toFixed(2)}€  -> real payout ${w.realPrize.toFixed(2)}€  | profit ${v3Profit.toFixed(2)}€`);
  }
  console.log(`\n=== TOTALS over ${eds.length} editions with real entries ===`);
  console.log(`  real fees collected: ${totFees.toFixed(2)}€`);
  console.log(`  CURRENT model profit: ${totCurProfit.toFixed(2)}€`);
  console.log(`  V3 WALL    profit:    ${totV3Profit.toFixed(2)}€   (guaranteed >= ${(TARGET_MARGIN * totFees).toFixed(2)}€)`);

  await cn.end(); child.kill();
}
main().catch(e => { console.error(e); process.exit(1); });
