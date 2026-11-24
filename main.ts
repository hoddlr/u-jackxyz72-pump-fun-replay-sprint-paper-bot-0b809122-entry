// main.ts — Pump.fun Replay Sprint paper bot (Node 22, stdlib only).
//
// Protokol: NDJSON stdin/stdout. Harness mengirim satu pesan hello di awal,
// lalu satu batch per slot, dan satu done di akhir. Bot membalas tepat satu
// reply berisi orders untuk setiap batch, lalu keluar diam-diam saat done.
// Semua keputusan deterministik: tanpa jam, tanpa acak, tanpa jaringan.
// Satu-satunya angka yang berubah antar batch hanyalah isi batch itu sendiri,
// jadi dua eksekusi atas replay yang sama menghasilkan reply yang identik.
//
// Strategi (garis besar, detail di bagian kedua file ini):
// momentum awal yang disiplin pada koin segar, keluar cepat lewat
// take-profit / stop-loss / trailing / batas tahan, dan rotasi modal
// supaya round trip tersebar ke banyak koin berbeda.
import * as readline from "node:readline";

// ---- konstanta: angka kompetisi, dibaca ulang dari hello saat runtime ----
const LAMPORTS_PER_SOL = 1000000000n;
const TX_FEE_LAMPORTS = 105000n; // base 5.000 + priority 100.000
const BUY_SIZE_LAMPORTS = 400000000n; // 0,4 SOL per entri
const MIN_BUY_LAMPORTS = 10000000n; // 0,01 SOL, ambang guardrail round trip
const MAX_POSITIONS = 5;
const MAX_BUYS_PER_BATCH = 2;
const SLIPPAGE_BPS = 500;

// ---- ambang strategi (bagian kedua memakai ini saat menyusun orders) ----
const TAKE_PROFIT = 1.15; // jual saat harga naik 15% dari harga masuk
const STOP_LOSS = 0.93; // jual saat harga turun 7% dari harga masuk
const TRAIL_ARM = 1.08; // trailing aktif setelah puncak naik 8%
const TRAIL_DROP = 0.95; // jual saat harga turun 5% dari puncak
const MAX_HOLD_SLOTS = 2000; // batas tahan satu posisi, dalam slot
const ENTRY_WINDOW_SLOTS = 800; // hanya koin yang terlihat ≤800 slot lalu
const MIN_TRADES_TO_ENTER = 5; // butuh minimal 5 trade tercatat
const MIN_ENTRY_GAIN = 1.05; // harga sudah naik ≥5% dari harga pertama
const MIN_ENTRY_VOLUME_LAMPORTS = 3000000000n; // volume kumulatif ≥3 SOL
const MIN_BUY_RATIO = 0.7; // ≥70% dari 10 trade terakhir adalah beli
const DRAWDOWN_PAUSE = 0.4; // jeda beli bila ekuitas turun >40% dari puncak

// ---- state global: semua berasal dari pesan hello dan batch ----
const cfg = {
  seed: "0",
  latencySlots: 2,
  maxPositions: MAX_POSITIONS,
  maxOrderBps: 100,
};
const coins = new Map(); // mint -> statistik koin (lihat newCoin)
const entries = new Map(); // mint -> { entryPrice, entrySlot, peak }
const tradedMints = new Set(); // mint yang pernah dibeli (tak dibeli ulang)
const pendingBuys = new Map(); // clientId -> mint, order beli belum resolve
const pendingSells = new Set(); // mint dengan order jual belum resolve
let cashLamports = 10000000000n;
let peakEquity = 10000000000; // ekuitas puncak, lamports (float, rasio saja)
let fillsSeen = 0;
let ordersSent = 0;
let orderCounter = 0;

function priceFromReserves(vQuote, vToken) {
  const q = BigInt(vQuote);
  const t = BigInt(vToken);
  if (t === 0n || q === 0n) return 0;
  return Number(q) / Number(t);
}

function newCoin(mint, slot, firstPrice) {
  return {
    mint,
    firstSlot: slot,
    firstPrice,
    lastPrice: firstPrice,
    lastSlot: slot,
    trades: 0,
    buys: 0,
    sells: 0,
    volQuote: 0n, // jumlah kumulatif quote_amount, lamports
    realQuote: 0n, // real_quote_reserves terbaru
    completed: false,
    lastTenBuys: [], // sisi 10 trade terakhir, true = beli
  };
}

function coinFor(mint, slot, firstPrice) {
  let c = coins.get(mint);
  if (!c) {
    c = newCoin(mint, slot, firstPrice);
    coins.set(mint, c);
  }
  return c;
}

// ---- parsing: fills dalam batch ----
// Fill buy yang terisi mencatat harga masuk; fill sell menghapus entri.
function applyFills(batch) {
  const fills = batch.fills || [];
  for (const f of fills) {
    fillsSeen += 1;
    if (pendingBuys.has(f.client_id)) pendingBuys.delete(f.client_id);
    // Fill jual apa pun statusnya membebaskan mint untuk keputusan keluar
    // berikutnya (terisi, ditolak, atau gagal — ketiganya menutup percobaan).
    if (f.side === "sell") pendingSells.delete(f.mint);
    if (f.status !== "filled") continue;
    if (f.side === "buy") {
      const tokens = BigInt(f.token_amount);
      const quote = BigInt(f.quote_lamports);
      if (tokens === 0n || quote === 0n) continue;
      const p = Number(quote) / Number(tokens);
      entries.set(f.mint, { entryPrice: p, entrySlot: f.slot, peak: p });
      tradedMints.add(f.mint);
    } else if (f.side === "sell") {
      entries.delete(f.mint);
    }
  }
}

// ---- parsing: event rantai dalam batch ----
// CreateEvent membuka statistik koin; TradeEvent memperbarui harga, volume,
// dan arah trade; CompleteEvent menandai koin selesai (tak lagi dibeli).
function applyEvents(batch) {
  const events = batch.events || [];
  for (const ev of events) {
    if (ev.event === "CreateEvent") {
      const p = priceFromReserves(
        ev.virtual_quote_reserves,
        ev.virtual_token_reserves,
      );
      const c = coinFor(ev.mint, ev.slot, p);
      if (c.trades === 0 && c.firstPrice === 0) {
        c.firstPrice = p;
        c.lastPrice = p;
        c.firstSlot = ev.slot;
      }
    } else if (ev.event === "TradeEvent") {
      const p = priceFromReserves(
        ev.virtual_quote_reserves,
        ev.virtual_token_reserves,
      );
      const c = coinFor(ev.mint, ev.slot, p);
      if (c.trades === 0 && c.firstPrice === 0) {
        c.firstPrice = p;
        c.firstSlot = ev.slot;
      }
      c.trades += 1;
      if (ev.is_buy) c.buys += 1;
      else c.sells += 1;
      c.volQuote += BigInt(ev.quote_amount);
      c.lastPrice = p;
      c.lastSlot = ev.slot;
      c.realQuote = BigInt(ev.real_quote_reserves);
      c.lastTenBuys.push(ev.is_buy === true);
      if (c.lastTenBuys.length > 10) c.lastTenBuys.shift();
    } else if (ev.event === "CompleteEvent") {
      const c = coins.get(ev.mint);
      if (c) c.completed = true;
      else {
        const fresh = newCoin(ev.mint, ev.slot, 0);
        fresh.completed = true;
        coins.set(ev.mint, fresh);
      }
    }
  }
}

// ---- parsing: marks dalam batch ----
// Mark memberi reserve terbaru untuk koin yang dipegang / ber-order pending.
function applyMarks(batch) {
  const marks = batch.marks || [];
  for (const m of marks) {
    const c = coins.get(m.mint);
    if (!c) continue;
    const p = priceFromReserves(
      m.virtual_quote_reserves,
      m.virtual_token_reserves,
    );
    if (p > 0) c.lastPrice = p;
    c.realQuote = BigInt(m.real_quote_reserves);
    c.lastSlot = m.slot;
  }
}

// ---- parsing: account dalam batch ----
// Account adalah sumber kebenaran posisi: kas dan token yang masih dipegang.
// Entri tanpa harga masuk dari fill memakai cost/token sebagai cadangan.
function applyAccount(batch) {
  const account = batch.account || {};
  if (account.cash_lamports !== undefined) {
    cashLamports = BigInt(account.cash_lamports);
  }
  const positions = account.positions || [];
  const held = new Set();
  for (const pos of positions) {
    held.add(pos.mint);
    if (!entries.has(pos.mint)) {
      const tokens = BigInt(pos.token_amount);
      const cost = BigInt(pos.cost_lamports);
      if (tokens > 0n && cost > 0n) {
        const p = Number(cost) / Number(tokens);
        entries.set(pos.mint, {
          entryPrice: p,
          entrySlot: batch.slot,
          peak: p,
        });
      }
    }
  }
  for (const mint of [...entries.keys()]) {
    if (!held.has(mint)) entries.delete(mint);
  }
  return positions;
}

// ---- ekuitas: kas + nilai posisi pada harga terakhir ----
function equityNow(positions) {
  let value = Number(cashLamports);
  for (const pos of positions) {
    const c = coins.get(pos.mint);
    const price = c && c.lastPrice > 0 ? c.lastPrice : 0;
    if (price > 0) value += Number(BigInt(pos.token_amount)) * price;
    else value += Number(BigInt(pos.cost_lamports));
  }
  return value;
}

function buyRatioLastTen(c) {
  if (c.lastTenBuys.length === 0) return 0;
  let n = 0;
  for (const b of c.lastTenBuys) if (b) n += 1;
  return n / c.lastTenBuys.length;
}

// ---- strategi: susun orders untuk satu batch ----
// Urutan kerja: keluar dulu dari posisi yang kena ambang, baru masuk ke
// koin segar. Semua urutan iterasi diurutkan (mint / firstSlot) supaya
// hasilnya sama persis setiap kali replay yang sama diputar ulang.
function nextClientId(prefix) {
  orderCounter += 1;
  return prefix + orderCounter.toString(36);
}

function decideOrders(batch, positions, equity) {
  const orders = [];
  const slot = batch.slot;
  const held = new Set(positions.map((p) => p.mint));
  const pendingMints = new Set(pendingBuys.values());

  // Jeda beli bila ekuitas sudah jauh di bawah puncak (jaga drawdown).
  const drawdown =
    peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
  const pauseBuys = drawdown > DRAWDOWN_PAUSE;

  // --- keluar: satu sell per posisi yang kena ambang ---
  const sortedPositions = [...positions].sort((a, b) =>
    a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0,
  );
  for (const pos of sortedPositions) {
    const c = coins.get(pos.mint);
    if (c && c.completed) continue; // harness yang menutup koin selesai
    if (pendingSells.has(pos.mint)) continue; // sudah ada jual yang jalan
    const entry = entries.get(pos.mint);
    if (!entry) continue;
    const price = c ? c.lastPrice : 0;
    if (price <= 0) continue;
    if (price > entry.peak) entry.peak = price;
    const gain = price / entry.entryPrice;
    const peakGain = entry.peak / entry.entryPrice;
    const agedOut = slot - entry.entrySlot >= MAX_HOLD_SLOTS;
    const takeProfit = gain >= TAKE_PROFIT;
    const stopLoss = gain <= STOP_LOSS;
    const trailing =
      peakGain >= TRAIL_ARM && price <= entry.peak * TRAIL_DROP;
    if (!takeProfit && !stopLoss && !trailing && !agedOut) continue;
    orders.push({
      side: "sell",
      client_id: nextClientId("s"),
      mint: pos.mint,
      token_amount: String(pos.token_amount),
      max_slippage_bps: SLIPPAGE_BPS,
    });
    pendingSells.add(pos.mint);
  }

  // --- masuk: beli koin segar yang lolos filter momentum ---
  let committed = positions.length + pendingBuys.size;
  let reservedCash = BigInt(pendingBuys.size) * BUY_SIZE_LAMPORTS;
  let buysThisBatch = 0;
  if (!pauseBuys && committed < cfg.maxPositions) {
    const candidates = [...coins.values()]
      .filter((c) => {
        if (c.completed) return false;
        if (tradedMints.has(c.mint)) return false;
        if (held.has(c.mint)) return false;
        if (pendingMints.has(c.mint)) return false;
        if (slot - c.firstSlot > ENTRY_WINDOW_SLOTS) return false;
        if (c.trades < MIN_TRADES_TO_ENTER) return false;
        if (c.firstPrice <= 0) return false;
        if (c.lastPrice < c.firstPrice * MIN_ENTRY_GAIN) return false;
        if (c.volQuote < MIN_ENTRY_VOLUME_LAMPORTS) return false;
        if (buyRatioLastTen(c) < MIN_BUY_RATIO) return false;
        if (c.realQuote <= 0n) return false;
        return true;
      })
      .sort((a, b) =>
        a.firstSlot !== b.firstSlot
          ? a.firstSlot - b.firstSlot
          : a.mint < b.mint
            ? -1
            : a.mint > b.mint
              ? 1
              : 0,
      );
    for (const c of candidates) {
      if (buysThisBatch >= MAX_BUYS_PER_BATCH) break;
      if (committed >= cfg.maxPositions) break;
      if (orders.length >= 16) break;
      // Cap: 90 bps dari real reserve (di bawah cap 100 bps kompetisi).
      const capSize = (c.realQuote * 9n) / 1000n;
      let size = BUY_SIZE_LAMPORTS;
      if (size > capSize) size = capSize;
      if (size < MIN_BUY_LAMPORTS) continue;
      const freeCash = cashLamports - reservedCash;
      if (size + TX_FEE_LAMPORTS > freeCash) continue;
      const clientId = nextClientId("b");
      orders.push({
        side: "buy",
        client_id: clientId,
        mint: c.mint,
        quote_lamports: size.toString(),
        max_slippage_bps: SLIPPAGE_BPS,
      });
      pendingBuys.set(clientId, c.mint);
      reservedCash += size + TX_FEE_LAMPORTS;
      committed += 1;
      buysThisBatch += 1;
    }
  }
  return orders;
}

// ---- main loop: baca hello / batch / done dari stdin ----
// Satu reply per batch, menggemakan seq batch itu; done dibalas dengan keluar.
async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error("baris stdin bukan JSON, berhenti");
      process.exit(1);
    }
    if (msg.type === "hello") {
      cfg.seed = String(msg.seed ?? "0");
      if (msg.caps) {
        if (msg.caps.max_open_positions !== undefined) {
          cfg.maxPositions = msg.caps.max_open_positions;
        }
        if (msg.caps.max_order_bps_of_real_reserve !== undefined) {
          cfg.maxOrderBps = msg.caps.max_order_bps_of_real_reserve;
        }
      }
      if (msg.latency_slots !== undefined) {
        cfg.latencySlots = msg.latency_slots;
      }
      if (msg.capital && msg.capital.lamports !== undefined) {
        cashLamports = BigInt(msg.capital.lamports);
        peakEquity = Number(cashLamports);
      }
    } else if (msg.type === "batch") {
      applyFills(msg);
      applyEvents(msg);
      applyMarks(msg);
      const positions = applyAccount(msg);
      const equity = equityNow(positions);
      if (equity > peakEquity) peakEquity = equity;
      const orders = decideOrders(msg, positions, equity);
      ordersSent += orders.length;
      process.stdout.write(
        JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n",
      );
    } else if (msg.type === "done") {
      console.error(
        `done: fills=${fillsSeen} orders=${ordersSent} cash=${cashLamports}`,
      );
      break;
    } else {
      console.error(`tipe pesan tak dikenal: ${msg.type}`);
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error(String((e && e.stack) || e));
  process.exit(1);
});
