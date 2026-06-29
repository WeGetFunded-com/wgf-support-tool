#!/usr/bin/env tsx
/** READ-ONLY stress test: V3 wall at high real volume + extreme stars. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

const TARGET_MARGIN = 0.85, WALL_MULT = 1.06, MIN_BOT_TOP_RANKS = 3;
const BAND = { from: 0, to: 0.15, exp: 0.8 };
const SUPPORT = "/Users/cyrilsalvi/Documents/WGF/wgf-support-shell";
const ENTRY_FEE = 19; // daily
const SAMPLE_EDITION = "4f726f04dfb94c3ca2ca116e3c10c045"; // live bot field

function findFreePort(): Promise<number> { return new Promise((res, rej) => { const s = createServer(); s.listen(0, () => { const a = s.address(); if (a && typeof a === "object") { const p = a.port; s.close(() => res(p)); } else { s.close(() => rej(new Error("no port"))); } }); s.on("error", rej); }); }
function waitForPort(port: number, ms: number): Promise<void> { return new Promise((res, rej) => { const dl = Date.now() + ms; (function t() { if (Date.now() > dl) return rej(new Error("tunnel timeout")); const sk = createConnection({ port, host: "127.0.0.1" }, () => { sk.destroy(); res(); }); sk.on("error", () => setTimeout(t, 300)); })(); }); }

function distribute(pool: number, feesRanked: number[]): number[] {
  const n = feesRanked.length; const prizes = new Array(n).fill(0);
  if (n === 0 || pool <= 0) return prizes;
  const members: number[] = [];
  for (let i = 0; i < n; i++) { const pct = i / n; if (pct >= BAND.from && pct < BAND.to) members.push(i); }
  const amount = pool; let sumW = 0; const w: number[] = [];
  for (let k = 0; k < members.length; k++) { const ww = Math.pow(k + 1, -BAND.exp); w.push(ww); sumW += ww; }
  for (let k = 0; k < members.length; k++) prizes[members[k]] = (amount * w[k]) / sumW;
  return prizes;
}
type Row = { ret: number; fee: number; isBot: boolean; eligible: boolean; tag?: string };
function rankOrganic(rows: Row[]): Row[] { return [...rows].sort((a, b) => (a.ret !== b.ret ? b.ret - a.ret : (!a.isBot && b.isBot ? -1 : 1))); }
function realPrizes(ranked: Row[], pool: number): { total: number; perRow: Map<Row, number> } {
  const elig = ranked.filter(r => r.eligible); const pr = distribute(pool, elig.map(r => r.fee));
  let s = 0; const m = new Map<Row, number>(); elig.forEach((r, i) => { if (!r.isBot) { s += pr[i]; m.set(r, pr[i]); } }); return { total: s, perRow: m };
}
function applyWall(rows: Row[], pool: number, B: number) {
  const bots = rows.filter(r => r.isBot).sort((a, b) => b.ret - a.ret); const maxD = bots.length;
  for (let d = MIN_BOT_TOP_RANKS; d <= maxD; d++) {
    const sharks = new Set(bots.slice(0, d)); const rest = rows.filter(r => !sharks.has(r));
    const ranked = bots.slice(0, d).concat(rankOrganic(rest));
    const rp = realPrizes(ranked, pool);
    if (rp.total <= B + 1e-9) return { d, ranked, rp, topShark: bots[0]?.ret };
  }
  const ranked = bots.concat(rankOrganic(rows.filter(r => !r.isBot)));
  return { d: maxD, ranked, rp: realPrizes(ranked, pool), topShark: bots[0]?.ret };
}

// deterministic gaussian-ish real return generator
function lcg(seed: number) { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; }
function makeReals(n: number, seed: number): Row[] {
  const rnd = lcg(seed); const reals: Row[] = [];
  for (let i = 0; i < n; i++) {
    const u1 = Math.max(1e-9, rnd()), u2 = rnd();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    let ret = 0.02 + 0.07 * z;            // mean +2%, std 7%
    if (ret < -0.05) ret = -0.05;          // breach floor
    if (ret > 0.45) ret = 0.45;            // believable human cap
    reals.push({ ret, fee: ENTRY_FEE, isBot: false, eligible: ret !== 0 });
  }
  // inject extreme stars
  reals.push({ ret: 1.00, fee: ENTRY_FEE, isBot: false, eligible: true, tag: "STAR+100%" });
  reals.push({ ret: 1.90, fee: ENTRY_FEE, isBot: false, eligible: true, tag: "STAR+190%" });
  return reals;
}

async function main() {
  const env = dotenv.parse(readFileSync(join(SUPPORT, ".env"), "utf-8")); const pfx = "STAGING";
  const localPort = await findFreePort();
  const child: ChildProcess = spawn("kubectl", [`--server=${env.KUBE_SERVER}`, `--token=${env.KUBE_TOKEN}`, "--insecure-skip-tls-verify", "port-forward", `pod/${env[`${pfx}_POD_NAME`]}`, `${localPort}:${env[`${pfx}_POD_PORT`]}`, "-n", env[`${pfx}_NAMESPACE`]], { stdio: ["ignore", "pipe", "pipe"] });
  let serr = ""; child.stderr?.on("data", d => serr += d);
  await Promise.race([waitForPort(localPort, 15000), new Promise((_, rej) => child.on("exit", c => c && rej(new Error("tunnel: " + serr))))]);
  const cn = await mysql.createConnection({ host: "127.0.0.1", port: localPort, user: env[`${pfx}_DB_USER`], password: env[`${pfx}_DB_PASSWORD`], database: env[`${pfx}_DB_NAME`], ssl: { rejectUnauthorized: false } });

  const [botRows]: any = await cn.execute(`SELECT final_return_pct ret, notional_fee fee FROM contest_bot WHERE edition_uuid=UNHEX(?)`, [SAMPLE_EDITION]);
  const botField = (): Row[] => botRows.filter((b: any) => b.ret != null).map((b: any) => ({ ret: Number(b.ret), fee: Number(b.fee), isBot: true, eligible: Number(b.ret) !== 0 }));

  console.log(`\n=== V3 WALL STRESS TEST (daily, ${botRows.length} live bots, +100%/+190% stars injected) ===`);
  console.log(`    margin ${TARGET_MARGIN * 100}% | shark x${WALL_MULT} | reals never top ${MIN_BOT_TOP_RANKS}\n`);
  for (const N of [10, 50, 100, 200, 400]) {
    const reals = makeReals(N, 12345 + N);
    const rows = botField().concat(reals);
    const realFees = reals.length * ENTRY_FEE;
    const botNotional = botRows.length * ENTRY_FEE;
    const pool = Math.max(2000, 0.89 * (realFees + botNotional));
    const B = (1 - TARGET_MARGIN) * realFees;

    // CURRENT
    const cur = realPrizes(rankOrganic(rows), pool);
    // V3
    const w = applyWall(rows, pool, B);
    const winners = [...w.rp.perRow.values()].filter(v => v > 0.005).length;
    const maxLot = Math.max(0, ...w.rp.perRow.values());
    const star190 = reals.find(r => r.tag === "STAR+190%")!;
    const star190Rank = w.ranked.indexOf(star190) + 1;
    const star190Lot = w.rp.perRow.get(star190) || 0;
    const profitCur = realFees - cur.total, profitV3 = realFees - w.rp.total;

    console.log(`--- ${reals.length} réels (dont 2 stars), pool=${pool.toFixed(0)}€, B=${B.toFixed(0)}€ ---`);
    console.log(`  ACTUEL : payout réels ${cur.total.toFixed(0)}€  -> profit ${profitCur.toFixed(0)}€`);
    console.log(`  V3     : mur d=${w.d}, top shark ~${((w.topShark || 0) > star190.ret ? star190.ret * WALL_MULT : (w.topShark || 0)) * 100 | 0}%+, payout réels ${w.rp.total.toFixed(0)}€ (<=B ${(w.rp.total <= B + 1).toString()}), gagnants ${winners}, plus gros lot ${maxLot.toFixed(0)}€`);
    console.log(`           STAR+190% -> rang #${star190Rank}, lot ${star190Lot.toFixed(2)}€  | profit ${profitV3.toFixed(0)}€ (marge ${(profitV3 / realFees * 100).toFixed(0)}%)\n`);
  }
  await cn.end(); child.kill();
}
main().catch(e => { console.error(e); process.exit(1); });
