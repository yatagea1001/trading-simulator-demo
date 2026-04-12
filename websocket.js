console.log("%c[JS] V17 - ON-DEMAND ONLY (HAPUS NINJA PREFETCH)", "color: #00FFAA; font-weight:bold; background: #0B0E11; padding: 4px;");

// =========================================================
// CHANGELOG V17 (dari V16):
//   1. HAPUS ninja prefetch sepenuhnya
//      → Tidak ada background download pair yang tidak dipilih user
//      → Scalable ke 1000+ pair tanpa makan RAM/storage
//   2. Market Watch price → dari tick stream live (wasm_push_tick selalu jalan)
//      → C++ sudah aman: UpdateTick() dipanggil semua sym, candle hanya terbentuk
//        kalau ada tab buka pair itu ATAU pair itu adalah g_symbol
//   3. Tick handler → selalu teruskan ke WASM (tidak perlu downloadedSymbols guard)
//      → downloadedSymbols tetap ada untuk footprint/tick_flow guard (orderflow.js)
//   4. Startup → TIDAK scan IDB semua pair, TIDAK push prefetchQueue
//      → Hanya load pair yang dipilih user (SetActiveSymbol/picker)
//   5. addToBuffer untuk tick → HANYA untuk CURRENT_SYMBOL dan tab aktif
//      → Tick pair lain tidak masuk IDB
//   6. ALL_SYMBOLS → tetap ada untuk Market Watch initial row setup
//      → Tapi TIDAK digunakan untuk download background
// =========================================================

const WS_URL = "ws://127.0.0.1:8765";
//const WS_URL = "wss://specializing-respondents-telephone-renew.trycloudflare.com";

// =========================================================
// 1. STATE
// =========================================================

// 🔥 SCALABLE: Pisah forex & crypto — mudah tambah pair nanti
// Cukup tambah nama pair di sini, tidak perlu ubah kode lain
const SYMBOLS_FOREX  = ["XAUUSD","EURUSD","GBPUSD"];
const SYMBOLS_CRYPTO = ["BTCUSDT","ETHUSDT"];
const ALL_SYMBOLS    = [...SYMBOLS_FOREX, ...SYMBOLS_CRYPTO];

let CURRENT_SYMBOL = ""; // Kosong → tunggu picker C++ pilih dulu
let lastWasmTime   = 0;

var isWasmReady   = false;
var isWSConnected = false;

let isDownloading      = false;
let isRendering        = false; // true saat rebuildFullFromDB berjalan
let pendingSymbolSwitch = null;
let downloadedSymbols  = new Set();
let downloadedCandles  = [];
let candleBuffer       = [];

// ══════════════════════════════════════════════════════════════
// 🔒 REBUILD MUTEX — mencegah double/triple rebuild concurrent
//
// Masalah: rebuildFullFromDB() berisi `await getAllCandlesFromDB()`
// yang menyebabkan JS yield ke event loop. Saat itu lazy/gap bisa
// masuk dan memanggil rebuildFullFromDB lagi → 3 rebuild bersamaan.
//
// Solusi: flag g_rebuildInProgress sebagai mutex.
// Siapa pun yang masuk lebih dahulu, yang lain skip/wait.
// ══════════════════════════════════════════════════════════════
let g_rebuildInProgress = false;

// ══════════════════════════════════════════════════════════════
// 🔥 GAP PREFILL BEFORE RENDER
// Digunakan saat CACHE HIT — gap fill harus selesai SEBELUM
// rebuildFullFromDB dipanggil, agar render pertama sudah lengkap.
// g_prefillResolve: callback Promise yang di-resolve handleGapData
// ══════════════════════════════════════════════════════════════
let g_prefillResolve = null; // set saat menunggu gap prefill, null saat idle

// ══════════════════════════════════════════════════════════════
// 🔥 LAZY GAP FILL — ON-DEMAND SAAT USER PILIH SYMBOL
// Startup: scan IDB → catat gap di memory → TIDAK request apapun
// User pilih symbol → cek g_startupGapMap → kalau ada gap →
//   prefillGapBeforeRender → simpan IDB → baru render
// Paling hemat: request hanya terjadi saat user betul-betul butuh
// ══════════════════════════════════════════════════════════════
const g_startupGapMap = new Map(); // symbol → latestTime (cache dari startup scan)

// 🔒 INITIAL LOAD GUARD — block lazy selama startup flow
// Set true saat SetActiveSymbol mulai, false setelah gap terselesaikan.
// Mencegah lazy dari C++ ikut-ikutan rebuild sebelum data awal selesai.
let g_initialLoadDone = true; // default true (hanya false saat switch symbol)

// 🥷 NINJA PRE-FETCH VARIABLES
// V17: prefetchQueue DIHAPUS — tidak ada background download
// downloadedSymbols tetap ada untuk guard di websocket_orderflow.js (footprint/tick_flow)

function logInfo(m) { console.log ("%c" + m, "color:#0af"); }
function logGood(m) { console.log ("%c" + m, "color:#0f0;font-weight:bold"); }
function logWarn(m) { console.warn("%c" + m, "color:orange;font-weight:bold"); }
function logErr (m) { console.error("%c"+ m, "color:red;font-weight:bold"); }

// =========================================================
// UTIL: isCryptoSymbol
// Sentralisasi cek crypto — dipakai di bar close & footprint request
// Tambah pair baru di SYMBOLS_CRYPTO, fungsi ini otomatis tahu
// =========================================================
function isCryptoSymbol(sym) {
    return SYMBOLS_CRYPTO.includes(sym) || sym.includes("USDT") || sym === "BTC" || sym === "ETH";
}

// =========================================================
// SATU FUNGSI UNTUK KIRIM TICK KE C++
// =========================================================
function sendTickToWasm(symbol, price, vol, time) {
    if (!isWasmReady || !Module || !Module.ccall) return;
    Module.ccall('wasm_push_tick', null,
        ['string', 'number', 'number', 'number'],
        [symbol,   price,    vol,      time]);
}

// =========================================================
// 🥷 NINJA BACKGROUND PRE-FETCH PROCESSOR
// =========================================================
// V17: processPrefetchQueue DIHAPUS — tidak ada background download pair

// =========================================================
// 2. PROGRESS UI
// =========================================================
function showLoadingOverlay(msg, pct = 0) {
    let ov = document.getElementById('data-loading-overlay');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'data-loading-overlay';
        ov.style.cssText = `
            position:fixed;top:0;left:0;width:100%;height:100%;
            background:rgba(0,0,0,.85);z-index:9998;
            display:flex;flex-direction:column;align-items:center;justify-content:center;
            color:#0af;font-family:'Segoe UI',sans-serif;pointer-events:none;`;
        ov.innerHTML = `
            <div style="text-align:center">
              <div id="ov-msg"  style="font-size:18px;font-weight:bold;margin-bottom:20px">Loading...</div>
              <div style="width:320px;height:8px;background:#222;border-radius:4px;overflow:hidden;margin-bottom:10px">
                <div id="ov-bar" style="width:0%;height:100%;background:linear-gradient(90deg,#0af,#0f0);transition:width .3s"></div>
              </div>
              <div id="ov-detail" style="font-size:13px;color:#888">Preparing...</div>
            </div>`;
        document.body.appendChild(ov);
    }
    ov.style.display = 'flex';
    document.getElementById('ov-msg').innerText    = msg;
    document.getElementById('ov-bar').style.width  = pct + '%';
    document.getElementById('ov-detail').innerText = Math.round(pct) + '%';
}

function hideLoadingOverlay() {
    const ov = document.getElementById('data-loading-overlay');
    if (ov) ov.style.display = 'none';
}

// ── CORNER SPINNER — indikator background activity (prefetch/prepend) ───────
// Muncul saat ada aktivitas background (IDB write, prepend, prefetch).
// Tidak ada teks — hanya 3 titik berputar di pojok kanan bawah.
// User tahu "masih ada proses" → lebih sabar kalau ada frame drop kecil.
// Hilang otomatis saat semua background activity selesai.
(function() {
    // Inject CSS keyframes sekali
    const style = document.createElement('style');
    style.textContent = `
        @keyframes _yt_dot { 0%,80%,100%{opacity:.15} 40%{opacity:1} }
        #_yt_spinner { position:fixed;bottom:14px;right:14px;z-index:9997;
            display:none;align-items:center;gap:4px;pointer-events:none; }
        #_yt_spinner span { width:6px;height:6px;border-radius:50%;
            background:#4af;display:block;
            animation:_yt_dot 1.2s ease-in-out infinite; }
        #_yt_spinner span:nth-child(1){animation-delay:0s}
        #_yt_spinner span:nth-child(2){animation-delay:.2s}
        #_yt_spinner span:nth-child(3){animation-delay:.4s}
    `;
    document.head.appendChild(style);

    const el = document.createElement('div');
    el.id = '_yt_spinner';
    el.innerHTML = '<span></span><span></span><span></span>';
    document.body.appendChild(el);

    // Counter — berapa proses background sedang jalan
    let _count = 0;
    window._spinnerShow = function() {
        _count++;
        el.style.display = 'flex';
    };
    window._spinnerHide = function() {
        _count = Math.max(0, _count - 1);
        if (_count === 0) el.style.display = 'none';
    };
})();

function updateProgress(current, total, phase) {
    const pct = total > 0 ? (current / total) * 100 : 0;
    const bar = document.getElementById('ov-bar');
    const msg = document.getElementById('ov-msg');
    const det = document.getElementById('ov-detail');
    if (bar) bar.style.width  = pct + '%';
    if (msg) msg.innerText    = `${phase} ${CURRENT_SYMBOL}`;
    if (det) det.innerText    = `${current.toLocaleString()} / ${total.toLocaleString()} candles`;
    logInfo(`[PROGRESS] ${phase}: ${Math.round(pct)}% (${current}/${total})`);
}

// =========================================================
// 3. SWITCH PAIR
// =========================================================
window.SetActiveSymbol = async function(newSym) {
    if (isDownloading) {
        logWarn(`[UI] Still loading ${CURRENT_SYMBOL}, queued: ${newSym}`);
        pendingSymbolSwitch = newSym;
        return;
    }

    if (CURRENT_SYMBOL && CURRENT_SYMBOL === newSym && isWasmReady) return;

    logInfo(`[UI] Switching: ${CURRENT_SYMBOL} → ${newSym}`);
    await flushBuffer();

    const oldSym = CURRENT_SYMBOL;
    CURRENT_SYMBOL = newSym;
    lastWasmTime   = 0;
    g_noMoreHistory.delete(newSym);

    // 🔥 Clear FP cache untuk symbol lama saat switch
    // FP data di WASM akan di-clear saat wasm_clear_chart → request baru diizinkan
    // Kalau user balik ke symbol ini lagi → FP di-request fresh (data sudah di-clear WASM)
    if (oldSym && oldSym !== newSym && window.clearFPForSymbol) {
        window.clearFPForSymbol(oldSym);
    }
    g_lazyLoadInProgress = false;

    // 🔒 Kunci initial load — lazy TIDAK boleh rebuild selama proses ini
    g_initialLoadDone = false;

    g_tabSymbolMap.set(0, newSym);
    resetTabLazy(0);

    showLoadingOverlay(`Switching to ${newSym}...`, 0);

    if (Module && Module._wasm_clear_chart) {
        Module._wasm_clear_chart();
        logInfo(`[CHART] GPU + candles cleared for ${oldSym} → ${newSym}`);
    }

    await new Promise(r => setTimeout(r, 16)); // ~1 frame @ 60fps

    const existing = await getAllCandlesFromDB(CURRENT_SYMBOL);

    const MIN = 500;

    if (existing.length >= MIN) {
        logGood(`[CACHE HIT] ${CURRENT_SYMBOL}: ${existing.length} bars`);

        // ══════════════════════════════════════════════════════════
        // 🔥 ON-DEMAND GAP FILL saat user pilih symbol
        // g_startupGapMap sudah catat gap sejak startup scan (tanpa request).
        // Kalau symbol ini ada di map → pakai latestTime dari cache (lebih cepat).
        // Kalau tidak ada di map → hitung dari IDB (fallback).
        // ══════════════════════════════════════════════════════════
        const cachedLatest = g_startupGapMap.get(CURRENT_SYMBOL);
        const latestTime = cachedLatest
            ?? existing.reduce((max, c) => c.time > max ? c.time : max, 0);
        const nowEpoch   = Math.floor(Date.now() / 1000);
        const gapSeconds = nowEpoch - latestTime;
        const gapMinutes = Math.floor(gapSeconds / 60);
        const estCandles = Math.floor(gapSeconds / 60);

        if (gapSeconds > 30) {
            logWarn(`[GAP-PREFILL] ${gapMinutes}m gap (~${estCandles} candle) → fetch sebelum render dari ${new Date(latestTime*1000).toISOString().slice(0,19)}Z`);
            showLoadingOverlay(`Syncing ${CURRENT_SYMBOL} (${gapMinutes}m gap)...`, 0);
            await prefillGapBeforeRender(CURRENT_SYMBOL, latestTime);
            logGood(`[GAP-PREFILL] ✅ IDB sudah lengkap → lanjut render`);
        } else {
            logInfo(`[GAP] IDB fresh (gap ${gapSeconds}s) → langsung render`);
        }
        // 🔥 Hapus cache setelah gap terisi — next switch pakai hitung IDB fresh
        g_startupGapMap.delete(CURRENT_SYMBOL);

        showLoadingOverlay(`Loading ${CURRENT_SYMBOL} from cache`, 0);
        updateProgress(existing.length, existing.length, "Rendering");
        await rebuildFullFromDB(CURRENT_SYMBOL);
        hideLoadingOverlay();

        // Buka lazy setelah render pertama selesai
        g_initialLoadDone = true;
        logInfo(`[INIT] Initial load selesai — lazy diizinkan`);
    } else if (existing.length > 0) {
        logWarn(`[CACHE] Incomplete (${existing.length} < ${MIN}) → full download`);
        showLoadingOverlay(`Downloading ${CURRENT_SYMBOL} history`, 0);
        isDownloading = true;
        wsSend({ type: "request_sync", symbol: CURRENT_SYMBOL, count: 10000 }); // 10k candle
    } else {
        logWarn(`[CACHE MISS] ${CURRENT_SYMBOL} → download`);
        showLoadingOverlay(`Downloading ${CURRENT_SYMBOL} history`, 0);
        isDownloading = true;
        wsSend({ type: "request_sync", symbol: CURRENT_SYMBOL, count: 10000 }); // 10k candle
    }
};

// =========================================================
// 4. WASM BRIDGE
// =========================================================
function notifyWASM_candle(o, h, l, c, t, v) {
    if (!isWasmReady || !Module || !Module.ccall) return;
    if (Module._wasm_get_replay_gate && Module._wasm_get_replay_gate() === 1) return;
    Module.ccall('wasm_push_candle', null,
        ['number','number','number','number','number','number'],
        [o, h, l, c, t, v]);
}

// Footprint bridge — symbol wajib untuk routing primary vs non-primary tab
// 🔥 fromIDB=0 default → live feed (diblok gate C++ saat replay)
// Signature harus cocok dengan wasm_push_footprint di main.cpp (6 param)
function notifyWASM_footprint(symbol, time, price, buy_vol, sell_vol, fromIDB = 0) {
    if (!isWasmReady || !Module || !Module.ccall) return;
    Module.ccall('wasm_push_footprint', null,
        ['string', 'number', 'number', 'number', 'number', 'number'],
        [symbol, time, price, buy_vol, sell_vol, fromIDB]);
}
// Catatan: fmtUSD DIHAPUS dari sini (V16)
// Sudah ada di websocket_orderflow.js dan sudah global — tidak perlu duplikat

// =========================================================
// 5. INDEXEDDB
// =========================================================
let db = null;
const DB_NAME = 'TradingAppDB';
const DB_VER  = 2;
const STORE   = 'multi_candles';

async function initIndexedDB() {
    return new Promise((res, rej) => {
        const r = indexedDB.open(DB_NAME, DB_VER);
        r.onerror = () => { logErr('[DB] Open failed'); rej(); };
        r.onupgradeneeded = e => {
            db = e.target.result;
            if (db.objectStoreNames.contains('candles')) db.deleteObjectStore('candles');
            if (!db.objectStoreNames.contains(STORE)) {
                const s = db.createObjectStore(STORE, { keyPath: ['symbol', 'time'] });
                s.createIndex('symbol_idx', 'symbol', { unique: false });
            }
            logGood('[DB] Upgraded to V2');
        };
        r.onsuccess = e => { db = e.target.result; res(); };
    });
}

async function getAllCandlesFromDB(symbol) {
    if (!db) return [];
    return new Promise(res => {
        const t = db.transaction([STORE], 'readonly');
        const r = t.objectStore(STORE).index('symbol_idx').getAll(IDBKeyRange.only(symbol));
        r.onsuccess = () => res(r.result || []);
        r.onerror   = () => res([]);
    });
}

// V17: Ambil daftar symbol unik yang sudah ada di IDB (untuk downloadedSymbols tracking)
async function getAllSymbolsInDB() {
    if (!db) return [];
    return new Promise(res => {
        const t = db.transaction([STORE], 'readonly');
        const r = t.objectStore(STORE).index('symbol_idx').openKeyCursor(null, 'nextunique');
        const syms = [];
        r.onsuccess = e => {
            const cursor = e.target.result;
            if (cursor) { syms.push(cursor.key); cursor.continue(); }
            else res(syms);
        };
        r.onerror = () => res([]);
    });
}

async function saveBufferToDB(data) {
    if (!db || !data.length) return;
    const bigWrite = data.length > 500;
    if (bigWrite && window._spinnerShow) window._spinnerShow();
    const BATCH = 500;
    for (let i = 0; i < data.length; i += BATCH) {
        const chunk = data.slice(i, i + BATCH);
        await new Promise((res, rej) => {
            const t = db.transaction([STORE], 'readwrite');
            const s = t.objectStore(STORE);
            chunk.forEach(item => s.put(item));
            t.oncomplete = () => res();
            t.onerror    = e  => { console.error('[DB] Save error:', e); res(); };
        });
        if (i + BATCH < data.length)
            await new Promise(r => requestAnimationFrame(r));
    }
    if (bigWrite && window._spinnerHide) window._spinnerHide();
}

function addToBuffer(symbol, candles) {
    if (!candles || !candles.length) return;
    candleBuffer.push(...candles.map(c => ({
        symbol,
        time: c.time || c.t,
        o: c.o || c.open,  h: c.h || c.high,
        l: c.l || c.low,   c: c.c || c.close,
        v: c.v || c.volume || 1
    })));
}

async function flushBuffer() {
    if (!candleBuffer.length) return;
    const tmp = [...candleBuffer];
    candleBuffer = [];
    await saveBufferToDB(tmp);
}

// =========================================================
// 6. REBUILD FROM DB
// 🆕 V16: Pakai requestAnimationFrame bukan setTimeout(r, 10)
//
// Kenapa rAF lebih baik:
//   - setTimeout(r, 10) = tunggu 10ms FLAT, tidak peduli frame state
//   - requestAnimationFrame = yield TEPAT sebelum browser paint berikutnya
//   - Hasilnya: ImGui/WebGL dapat frame budget penuh tiap siklus
//   - Chart muncul bertahap (smooth progressif) tanpa freeze
//
// isRendering flag:
//   - Pasang sebelum loop mulai, lepas setelah HTF selesai
//   - Ninja cek flag ini sebelum minta data ke server
// =========================================================
// ── IDB range query: ambil candle lebih lama dari beforeTime ──────────────
async function getOlderCandlesFromDB(symbol, beforeTime, limit = 10000) {
    if (!db) return [];
    return new Promise(res => {
        const t = db.transaction([STORE], 'readonly');
        const range = IDBKeyRange.bound([symbol, 0], [symbol, beforeTime], false, true);
        const req = t.objectStore(STORE).getAll(range);
        req.onsuccess = () => {
            let r = req.result || [];
            r.sort((a, b) => b.time - a.time);  // newest-first
            r = r.slice(0, limit);               // ambil limit terbaru dari yang lebih lama
            r.reverse();                          // kembalikan oldest→newest untuk prepend
            res(r);
        };
        req.onerror = () => res([]);
    });
}

// ── Prepend candles ke WASM tanpa blokir chart ─────────────────────────────
// ── DEPRECATED: prependCandlesBackground ─────────────────────────────────────
// V2: Tidak lagi dipakai. Semua data path sekarang pakai:
//   clear WASM → rebuildFullFromDB (atomic push ALL dari IDB)
// Fungsi ini tetap ada untuk backward compat tapi tidak dipanggil.
async function prependCandlesBackground(candles) {
    if (!candles.length) return;
    if (!Module._wasm_begin_prepend) { logWarn('[PREPEND] wasm_begin_prepend belum ada'); return; }
    if (window._spinnerShow) window._spinnerShow();
    Module._wasm_begin_prepend();
    // V2: push atomic tanpa yield (kalau masih dipanggil dari mana)
    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        Module.ccall('wasm_prepend_candle', null,
            ['number','number','number','number','number','number'],
            [c.o, c.h, c.l, c.c, c.time, c.v || 1]);
    }
    Module._wasm_end_prepend();
    if (Module._wasm_rebuild_all_htfs) Module._wasm_rebuild_all_htfs();
    if (Module._wasm_sync_views_after_prepend) Module._wasm_sync_views_after_prepend();
    if (window._spinnerHide) window._spinnerHide();
    logGood(`[PREPEND] ✅ ${candles.length} candles prepended + HTF rebuilt`);
}

// ── ON-DEMAND LAZY LOAD V2 ───────────────────────────────────────────────
// Dipanggil C++ via EM_ASM saat scroll kiri mendekati ujung data.
// V2: TIDAK pakai prepend lagi. Clear WASM → rebuild ALL dari IDB.
// Ini menghilangkan race condition karena data selalu lengkap saat render.
const LAZY_CHUNK = 20000;
let g_lazyLoadInProgress = false;
let g_noMoreHistory      = new Set(); // 🔥 V2: per-symbol tracking

// =========================================================
// 🔥 PER-TAB LAZY STATE (V3)
// Setiap tab punya state sendiri → tidak rebutan dengan tab lain
// =========================================================
const g_tabLazy      = new Map(); // tabId → { inProgress, noMoreHistory }
const g_tabSymbolMap = new Map(); // tabId → symbol (diisi saat LoadTabSymbol)

// 🔥 FIX: Server tidak echo tab_id di gap_data response
// Kita track sendiri: symbol → tabId yang sedang menunggu gap
// Saat gap_data datang, lookup tabId dari symbol ini
const g_pendingTabGap  = new Map(); // symbol → tabId (request_gap / request_sync pending)
let   g_tabDownloadBuf = new Map(); // tabId → { sym, candles[] } — akumulasi multi-chunk history untuk tab
const g_pendingTabLazy = new Map(); // symbol → tabId (request_candles lazy pending)

function getTabLazy(tabId) {
    if (!g_tabLazy.has(tabId)) {
        g_tabLazy.set(tabId, { inProgress: false, noMoreHistory: false });
    }
    return g_tabLazy.get(tabId);
}

function resetTabLazy(tabId) {
    g_tabLazy.set(tabId, { inProgress: false, noMoreHistory: false });
}

window.onNearLeftEdge = async function(oldestTime) {
    if (g_lazyLoadInProgress) return;
    if (g_noMoreHistory.has(CURRENT_SYMBOL)) return;

    // 🔒 Block lazy selama initial load (SetActiveSymbol belum selesai gap fill)
    // Ini mencegah lazy ikut rebuild saat startup — penyebab double/triple rebuild
    if (!g_initialLoadDone) {
        logInfo(`[LAZY] ${CURRENT_SYMBOL}: initial load belum selesai, skip`);
        return;
    }

    // 🔒 Block lazy selama gap-prefill berjalan
    // g_prefillResolve != null = sedang await server response untuk gap fill
    // Kalau lazy jalan sekarang → double rebuild (lazy rebuild + prefill rebuild)
    if (g_prefillResolve) {
        logInfo(`[LAZY] ${CURRENT_SYMBOL}: gap-prefill aktif, skip (cegah double rebuild)`);
        return;
    }

    g_lazyLoadInProgress = true;
    logInfo(`[LAZY] ${CURRENT_SYMBOL} oldest: ${new Date(oldestTime * 1000).toISOString().slice(0,10)}`);

    // TAHAP 1: cek IDB dulu — gratis, tanpa network
    const older = await getOlderCandlesFromDB(CURRENT_SYMBOL, oldestTime, LAZY_CHUNK);
    if (older.length > 0) {
        logInfo(`[LAZY] IDB +${older.length} → rebuild`);
        // 🔥 V3: Simpan posisi view SEBELUM clear
        if (Module._wasm_save_view_anchor) Module._wasm_save_view_anchor();
        if (Module._wasm_clear_chart) Module._wasm_clear_chart();
        await rebuildFullFromDB(CURRENT_SYMBOL);
        // 🔥 V3: Restore posisi view SETELAH rebuild → user tidak kehilangan scroll
        if (Module._wasm_restore_view_anchor) Module._wasm_restore_view_anchor();
        logGood(`[LAZY] ✅ rebuilt from IDB (+${older.length})`);
        if (Module._wasm_set_lazy_load_done) Module._wasm_set_lazy_load_done();
        g_lazyLoadInProgress = false;
        return;
    }

    // TAHAP 2: IDB kosong → request server 20k sekaligus
    // Response di candle_page handler → simpan IDB → clear + rebuild
    logInfo(`[LAZY] IDB habis → req server before=${new Date(oldestTime*1000).toISOString().slice(0,10)}`);
    wsSend({ type: "request_candles", symbol: CURRENT_SYMBOL, before_time: oldestTime, limit: LAZY_CHUNK });
};

// =========================================================
// 🔥 PER-TAB LAZY TRIGGER (V3)
// tabId=0 = primary tab → pakai rebuildFullFromDB (global data)
// tabId>0 = non-primary  → pakai rebuildTabFromDB (SYMBOL_TF data)
// =========================================================
window.onNearLeftEdgeTab = async function(tabId, oldestTime) {
    const state = getTabLazy(tabId);
    if (state.inProgress || state.noMoreHistory) return;
    state.inProgress = true;

    const symbol = g_tabSymbolMap.get(tabId);
    if (!symbol) {
        logWarn(`[LAZY TAB${tabId}] symbol unknown, skip`);
        state.inProgress = false;
        return;
    }

    const isPrimary = (tabId === 0);
    const tag = isPrimary ? '[LAZY]' : `[LAZY TAB${tabId}]`;
    logInfo(`${tag} ${symbol} oldest: ${new Date(oldestTime*1000).toISOString().slice(0,10)}`);

    // TAHAP 1: cek IDB dulu — tanpa network
    const older = await getOlderCandlesFromDB(symbol, oldestTime, LAZY_CHUNK);
    if (older.length > 0) {
        logInfo(`${tag} IDB +${older.length} → rebuild`);
        if (isPrimary) {
            if (Module._wasm_save_view_anchor) Module._wasm_save_view_anchor();
            if (Module._wasm_clear_chart) Module._wasm_clear_chart();
            await rebuildFullFromDB(symbol);
            if (Module._wasm_restore_view_anchor) Module._wasm_restore_view_anchor();
            if (Module._wasm_set_lazy_load_done) Module._wasm_set_lazy_load_done();
        } else {
            if (Module._wasm_save_view_anchor_tab)
                Module.ccall('wasm_save_view_anchor_tab', null, ['number'], [tabId]);
            await rebuildTabFromDB(tabId, symbol);
            if (Module._wasm_restore_view_anchor_tab)
                Module.ccall('wasm_restore_view_anchor_tab', null, ['number'], [tabId]);
            if (Module._wasm_set_tab_lazy_done)
                Module.ccall('wasm_set_tab_lazy_done', null, ['number'], [tabId]);
        }
        state.inProgress = false;
        return;
    }

    // TAHAP 2: IDB kosong → request server
    logInfo(`${tag} IDB habis → req server before=${new Date(oldestTime*1000).toISOString().slice(0,10)}`);
    if (isPrimary) {
        wsSend({ type: "request_candles", symbol, before_time: oldestTime, limit: LAZY_CHUNK });
    } else {
        // Track pending agar candle_page bisa route ke tab yang benar
        // (server tidak selalu echo tab_id di response)
        g_pendingTabLazy.set(symbol, tabId);
        wsSend({ type: "request_candles", symbol, before_time: oldestTime, limit: LAZY_CHUNK, tab_id: tabId });
    }
};

// ─── rebuildTabFromDB — analog rebuildFullFromDB tapi untuk tab non-utama ───
// Key IDB sama: per-symbol (bukan per-tab) → semua tab BTCUSDT pakai IDB yang sama
// Setelah rebuild, GPU buffer tab ini langsung terupdate via wasm_rebuild_htfs_for_tab
async function rebuildTabFromDB(tabId, symbol) {
    let candles = await getAllCandlesFromDB(symbol);
    if (!candles.length) {
        logWarn(`[REBUILD TAB${tabId}] Tidak ada data IDB untuk ${symbol}`);
        return;
    }
    candles.sort((a, b) => a.time - b.time);

    if (Module._wasm_clear_tab) Module._wasm_clear_tab(tabId);

    // Atomic push — sama seperti rebuildFullFromDB, tidak ada rAF yield
    for (const c of candles) {
        Module.ccall('wasm_push_candle_for_tab', null,
            ['number','number','number','number','number','number','number'],
            [tabId, c.o, c.h, c.l, c.c, c.time, c.v || 1]);
    }

    if (Module._wasm_rebuild_htfs_for_tab)
        Module.ccall('wasm_rebuild_htfs_for_tab', null, ['number'], [tabId]);

    logGood(`[REBUILD TAB${tabId}] ✅ ${symbol}: ${candles.length} bars OK`);
}

// ── rebuildFullFromDB V2: ATOMIC PUSH (no yield, no prepend) ────────────────
// Push SEMUA candle dari IDB ke WASM dalam satu loop synchronous.
// Tidak ada rAF yield = tidak ada render loop jalan di tengah push = NO RACE CONDITION.
// 21000 candle × ccall ≈ 20ms — user tidak kerasa.
//
// 🔒 MUTEX: g_rebuildInProgress mencegah 2+ panggilan concurrent.
// Masalah: SetActiveSymbol dan lazy sama-sama await rebuildFullFromDB →
// JS yield di `await getAllCandlesFromDB` → keduanya jalan sekaligus →
// triple rebuild. Mutex memastikan hanya 1 yang jalan, sisanya skip.
async function rebuildFullFromDB(symbol) {
    if (!isWasmReady) { console.log('[REBUILD] WASM not ready'); return; }

    // 🔒 Cek mutex — kalau sudah ada rebuild berjalan, skip
    if (g_rebuildInProgress) {
        logWarn(`[REBUILD] Skipped (rebuild already in progress) for ${symbol}`);
        return;
    }
    g_rebuildInProgress = true;

    let candles = await getAllCandlesFromDB(symbol);
    if (!candles.length) { logWarn(`[REBUILD] No data for ${symbol}`); return; }

    candles.sort((a, b) => a.time - b.time);

    // ═══════════════════════════════════════════════════════════════
    // 🛡️ IDB SANITIZER: Hapus candle corrupt SEBELUM push ke WASM
    //
    // IDB bisa mengandung candle dari symbol lain (dari race condition
    // versi lama). Detect via median close price — candle yang > 5x
    // atau < 0.2x dari median = pasti dari symbol lain → buang.
    //
    // Ini JAUH lebih akurat dari guard C++ karena:
    //   1. Median dihitung dari data sendiri (tidak perlu MW live price)
    //   2. Filter sebelum masuk WASM → C++ selalu terima data bersih
    //   3. Tidak ada gap dari neutralize — candle corrupt benar-benar dihapus
    // ═══════════════════════════════════════════════════════════════
    if (candles.length > 10) {
        // Hitung median close dari 50% candle terbaru (paling akurat)
        const recent = candles.slice(-Math.max(100, Math.floor(candles.length * 0.5)));
        const closes = recent.map(c => c.c).sort((a, b) => a - b);
        const median = closes[Math.floor(closes.length / 2)];

        if (median > 0) {
            const hiLim = median * 5.0;
            const loLim = median * 0.2;
            const before = candles.length;

            // Collect corrupt candle times BEFORE filtering
            const corruptTimes = [];
            for (const c of candles) {
                if (!(c.c >= loLim && c.c <= hiLim && c.h > 0 && c.l > 0)) {
                    corruptTimes.push(c.time);
                }
            }

            candles = candles.filter(c =>
                c.c >= loLim && c.c <= hiLim &&
                c.h > 0 && c.l > 0
            );
            const removed = before - candles.length;
            if (removed > 0) {
                logWarn(`[REBUILD] 🛡️ ${removed} corrupt removed (median=${median.toFixed(2)})`);

                // 🔥 FIX: Hapus corrupt candles dari IDB juga!
                // Tanpa ini, lazy load menemukan mereka lagi → rebuild → sanitize → lazy → INFINITE LOOP
                try {
                    const delDb = await new Promise((res, rej) => {
                        const r = indexedDB.open(DB_NAME);
                        r.onsuccess = () => res(r.result);
                        r.onerror = () => rej(r.error);
                    });
                    const tx = delDb.transaction([STORE], 'readwrite');
                    const store = tx.objectStore(STORE);
                    for (const t of corruptTimes) {
                        store.delete([symbol, t]); // keyPath = [symbol, time]
                    }
                    await new Promise((res) => { tx.oncomplete = res; tx.onerror = res; });
                    logGood(`[REBUILD] 🗑️ ${removed} corrupt deleted from IDB`);
                } catch (e) {
                    console.warn('[REBUILD] Failed to delete corrupt from IDB:', e);
                }
            }
        }
    }

    logGood(`[REBUILD] ${candles.length} bars → push...`);

    isRendering = true;
    if (Module._wasm_set_primary_loading) Module._wasm_set_primary_loading(1);

    // 🔥 ATOMIC: push ALL candles in one synchronous loop
    for (const c of candles) {
        notifyWASM_candle(c.o, c.h, c.l, c.c, c.time, c.v);
        if (c.time > lastWasmTime) lastWasmTime = c.time;
    }

    if (Module._wasm_rebuild_all_htfs) Module._wasm_rebuild_all_htfs();
    if (Module._wasm_set_primary_loading) Module._wasm_set_primary_loading(0);
    isRendering = false;
    downloadedSymbols.add(symbol);
    hideLoadingOverlay();
    logGood(`[REBUILD] ✅ ${symbol}: ${candles.length} bars OK`);

    // 🔒 Lepas mutex
    g_rebuildInProgress = false;
}

// Simpan ke IDB SAJA — tidak push ke WASM, tidak ada render sama sekali.
window.reloadLiveAfterReplay = async function() {
    console.log('%c[RELOAD] Replay selesai — reload live dari IDB...', 'color:#00AAFF;font-weight:bold');

    if (!isWasmReady || !Module) {
        console.warn('[RELOAD] WASM belum ready, skip');
        return;
    }

    if (Module._wasm_clear_chart) {
        Module._wasm_clear_chart();
        console.log('[RELOAD] WASM cleared');
    }

    lastWasmTime = 0;

    // 🔥 FIX: Buka gate replay SEBELUM rebuildFullFromDB
    // Alasan: notifyWASM_candle() cek wasm_get_replay_gate() — kalau gate masih ON,
    // semua push candle di dalam rebuildFullFromDB di-skip → chart kosong.
    // Gate HARUS dibuka dulu agar candle bisa masuk ke WASM.
    if (Module._wasm_set_replay_mode) {
        Module._wasm_set_replay_mode(0);
        console.log('[RELOAD] Gate dibuka — siap terima candle dari IDB');
    }

    showLoadingOverlay('Restoring live data...', 0);
    await rebuildFullFromDB(CURRENT_SYMBOL);
    hideLoadingOverlay();

    // 🔥 SMART GUARD: Setelah replay selesai, reload FP jika sebelumnya aktif
    // clearAllFP() → reset tracking agar requestFootprint tidak di-skip
    // requestFootprint() → reload dari server dengan data terbaru
    // Ini memastikan angka footprint tidak stale setelah kembali ke live
    if (window.clearAllFP) {
        window.clearAllFP();
        console.log('[RELOAD] FP cache cleared — siap reload');
    }

    // 🔥 SMART GUARD: Cek apakah ada tab yang pakai FP atau VP style
    // Kalau ada → auto-request FP untuk symbol aktif
    // Trader tidak perlu klik ulang tombol FP setelah replay
    let needsFP = false;
    try {
        // Cek via JS — WASM expose info tab aktif
        if (Module._wasm_get_active_renderstyle) {
            const style = Module._wasm_get_active_renderstyle();
            // style 3,4,5 = FP_OVERLAY, FP_PROFILE, FP_BAR (sesuai enum CandleRenderStyle)
            needsFP = (style >= 3 && style <= 5);
        }
        // Fallback: kalau tidak ada fungsi itu, cek dari flag yang kita simpan
        if (!needsFP && window._lastFPStyleActive) {
            needsFP = true;
        }
    } catch(e) {}

    if (needsFP && CURRENT_SYMBOL) {
        console.log(`%c[RELOAD] Smart Guard: FP style aktif → auto-reload FP untuk ${CURRENT_SYMBOL}`,
            'color:#FF9900;font-weight:bold');
        // bypassGate=0 karena replay sudah selesai — gate sudah dibuka
        if (window.requestFootprint) {
            window.requestFootprint(CURRENT_SYMBOL, 500, 0);
        }
    }

    console.log('%c[RELOAD] ✅ Live restored! Gate dibuka.', 'color:#00FF88;font-weight:bold');
};

// =========================================================
// 7. WEBSOCKET HELPER
// =========================================================
let ws = null;

// ── Queue untuk pesan yang dikirim sebelum WS siap ───────────────
const g_wsSendQueue = [];

function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
    } else {
        // Antri — akan dikirim saat WS onopen
        g_wsSendQueue.push(obj);
        logInfo(`[WS] Queue +1 (${g_wsSendQueue.length} pending): ${obj.type}`);
    }
}

function wsFlushQueue() {
    if (!g_wsSendQueue.length) return;
    logInfo(`[WS] Flushing ${g_wsSendQueue.length} queued messages`);
    while (g_wsSendQueue.length > 0) {
        const obj = g_wsSendQueue.shift();
        if (ws && ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify(obj));
    }
}

async function connectWS() {
    if (isWSConnected || ws) { logWarn('[WS] Already connected'); return; }
    isWSConnected = true;
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        logGood('[WS] Connected!');
        wsFlushQueue();
        ws.send(JSON.stringify({ type: "init", email: "TRADER_CLIENT" }));

        // 🔥 ON-DEMAND GAP: tidak request apapun di sini.
        // g_startupGapMap sudah berisi gap info dari startup scan (memory only).
        // Gap akan di-request saat user pilih symbol → SetActiveSymbol.
        if (g_startupGapMap.size > 0) {
            const syms = [...g_startupGapMap.keys()].join(', ');
            logInfo(`[STARTUP] Gap info cached untuk: ${syms} — menunggu user pilih`);
        }

        if (CURRENT_SYMBOL && !downloadedSymbols.has(CURRENT_SYMBOL)) {
            // IDB kosong → download fresh
            showLoadingOverlay(`Downloading ${CURRENT_SYMBOL} history`, 0);
            isDownloading     = true;
            downloadedCandles = [];
            wsSend({ type: "request_sync", symbol: CURRENT_SYMBOL, count: 10000 });
        } else {
            logInfo("[WS] Connected, menunggu user pilih symbol dari picker...");
            hideLoadingOverlay();
        }

        setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), 30000);
    };

    ws.onmessage = async evt => {
        try {
            const msg = JSON.parse(evt.data);

            // ─────────────────────────────────────────────────────
            // A. HISTORY DOWNLOAD (Main Chart & Ninja)
            // ─────────────────────────────────────────────────────
            if (msg.type === "history" && msg.symbol) {
                const sym   = msg.symbol;
                const chunk = msg.candles || [];

                // 🔥 JALUR TAB NON-UTAMA: server kirim history untuk symbol yang
                // bukan CURRENT_SYMBOL — ini response dari request_sync Tab tertentu
                // g_pendingTabGap track: symbol → tabId yang menunggu
                // CATATAN: cek ini DULU sebelum CURRENT_SYMBOL check karena bisa overlap
                if (g_pendingTabGap.has(sym) && !(sym === CURRENT_SYMBOL && isDownloading)) {
                    const tabId = g_pendingTabGap.get(sym);

                    // Akumulasi chunks (server bisa kirim multi-chunk)
                    if (!g_tabDownloadBuf.has(tabId)) g_tabDownloadBuf.set(tabId, { sym, candles: [] });
                    if (chunk.length) g_tabDownloadBuf.get(tabId).candles.push(...chunk);

                    let done = false;
                    if (msg.chunk_info) {
                        const [cur, tot] = msg.chunk_info.split('/').map(Number);
                        if (cur >= tot) done = true;
                    } else if (!chunk.length && g_tabDownloadBuf.get(tabId).candles.length > 0) {
                        done = true;
                    } else if (chunk.length > 0 && !msg.chunk_info) {
                        done = true; // single chunk tanpa chunk_info
                    }

                    if (done) {
                        const allCandles = g_tabDownloadBuf.get(tabId).candles;
                        g_tabDownloadBuf.delete(tabId);
                        g_pendingTabGap.delete(sym);
                        logGood(`[TAB${tabId}] HIST ✅ ${sym}: ${allCandles.length} candles → rebuild`);
                        addToBuffer(sym, allCandles);
                        await flushBuffer();
                        await rebuildTabFromDB(tabId, sym);
                    }
                    return;
                }

                // JALUR 1: DOWNLOAD NORMAL (chart aktif)
                if (sym === CURRENT_SYMBOL) {
                    if (chunk.length) downloadedCandles.push(...chunk);

                    let done = false;
                    if (msg.chunk_info) {
                        const [cur, tot] = msg.chunk_info.split('/').map(Number);
                        updateProgress(cur, tot, "Downloading");
                        if (cur >= tot) done = true;
                    } else if (!chunk.length && downloadedCandles.length > 0) {
                        done = true;
                    }

                    if (done) {
                        updateProgress(downloadedCandles.length, downloadedCandles.length, "Saving");
                        addToBuffer(sym, downloadedCandles);
                        await flushBuffer();
                        await rebuildFullFromDB(sym);

                        hideLoadingOverlay();
                        isDownloading = false;
                        // 🔥 FIX: Buka lazy setelah CACHE MISS download selesai
                        // Sebelumnya g_initialLoadDone tidak di-set true di sini
                        // → lazy terblokir selamanya setelah download pertama
                        g_initialLoadDone = true;
                        logInfo(`[INIT] CACHE MISS selesai — lazy diizinkan`);

                        logGood(`✅ ${sym} fully loaded!`);

                        // Request footprint setelah chart beres
                        // V2: FP hanya di-request saat user pilih FP style

                        if (pendingSymbolSwitch) {
                            const next = pendingSymbolSwitch;
                            pendingSymbolSwitch = null;
                            setTimeout(() => window.SetActiveSymbol(next), 300);
                        }
                        // V17: tidak ada ninja setelah chart selesai
                    }
                }
                // V17: JALUR 2 (ninja) DIHAPUS — tidak ada background download
                return;
            }

            // ─────────────────────────────────────────────────────
            // A2. CANDLE_PAGE — lazy load pagination dari server
            // Dikirim server sebagai respons request_candles
            // Berisi candle lebih lama dari titik tertua yg ada di client
            // ─────────────────────────────────────────────────────
            if (msg.type === "candle_page" && msg.symbol) {
                const sym     = msg.symbol;
                const candles = msg.candles || [];
                const hasMore = msg.has_more === true;

                // 🔥 PER-TAB DISPATCH: kalau response punya tab_id, ATAU symbol ada di g_pendingTabLazy
                // Server tidak selalu echo tab_id → kita track sendiri via g_pendingTabLazy
                const pendingLazyTabId = msg.tab_id !== undefined
                    ? msg.tab_id
                    : g_pendingTabLazy.get(sym);

                if (pendingLazyTabId !== undefined && !(sym === CURRENT_SYMBOL && !g_pendingTabLazy.has(sym))) {
                    const tabId = pendingLazyTabId;
                    if (!candles.length) {
                        logWarn(`[PAGE TAB${tabId}] no more history untuk ${sym}`);
                        g_pendingTabLazy.delete(sym);
                        getTabLazy(tabId).noMoreHistory = true;
                        if (Module._wasm_set_tab_no_more_history)
                            Module.ccall('wasm_set_tab_no_more_history', null, ['number'], [tabId]);
                        return;
                    }
                    logGood(`[PAGE TAB${tabId}] ✅ ${sym}: ${candles.length} candles → rebuild`);
                    g_pendingTabLazy.delete(sym);
                    addToBuffer(sym, candles);
                    await flushBuffer();
                    // 🔥 V3: Save/restore view anchor saat rebuild tab dari server
                    if (Module._wasm_save_view_anchor_tab)
                        Module.ccall('wasm_save_view_anchor_tab', null, ['number'], [tabId]);
                    await rebuildTabFromDB(tabId, sym);
                    if (Module._wasm_restore_view_anchor_tab)
                        Module.ccall('wasm_restore_view_anchor_tab', null, ['number'], [tabId]);
                    if (Module._wasm_set_tab_lazy_done)
                        Module.ccall('wasm_set_tab_lazy_done', null, ['number'], [tabId]);
                    getTabLazy(tabId).inProgress = false;
                    return;
                }

                if (sym !== CURRENT_SYMBOL) return; // ignore untuk symbol lain

                if (!candles.length) {
                    logInfo('[PAGE] Server: tidak ada data lebih lama');
                    g_noMoreHistory.add(sym);
                    // 🔥 FIX: Sync JS per-tab state primary (tabId=0)
                    getTabLazy(0).inProgress    = false;
                    getTabLazy(0).noMoreHistory = true;
                    if (Module._wasm_set_lazy_load_done) Module._wasm_set_lazy_load_done();
                    if (Module._wasm_set_tab_no_more_history)
                        Module.ccall('wasm_set_tab_no_more_history', null, ['number'], [0]);
                    g_lazyLoadInProgress = false;
                    return;
                }

                logGood(`[PAGE] ✅ ${candles.length} candles dari server (has_more=${hasMore})`);

                // 🔥 V2: Simpan ke IDB SAJA — tidak langsung push ke WASM
                addToBuffer(sym, candles);
                await flushBuffer();

                // 🔥 V3: Simpan posisi view SEBELUM clear
                if (Module._wasm_save_view_anchor) Module._wasm_save_view_anchor();
                if (Module._wasm_clear_chart) Module._wasm_clear_chart();
                await rebuildFullFromDB(sym);
                // 🔥 V3: Restore posisi view SETELAH rebuild
                if (Module._wasm_restore_view_anchor) Module._wasm_restore_view_anchor();

                if (!hasMore) {
                    logInfo('[PAGE] Server sudah habis — tidak akan request lagi');
                    g_noMoreHistory.add(sym);
                    // 🔥 FIX: Sync JS per-tab state
                    getTabLazy(0).noMoreHistory = true;
                    if (Module._wasm_set_tab_no_more_history)
                        Module.ccall('wasm_set_tab_no_more_history', null, ['number'], [0]);
                }

                // 🔥 FIX: Buka gate JS per-tab state primary agar lazy bisa trigger lagi
                getTabLazy(0).inProgress = false;

                if (Module._wasm_set_lazy_load_done) Module._wasm_set_lazy_load_done();
                g_lazyLoadInProgress = false;
                return;
            }

            // ─────────────────────────────────────────────────────
            // B. TICK LIVE
            // V17: SELALU kirim ke WASM untuk Market Watch (semua pair)
            // C++ wasm_push_tick sudah aman:
            //   - UpdateTick() dipanggil untuk semua sym → MW hidup
            //   - Candle hanya terbentuk kalau ada tab buka pair itu
            // addToBuffer HANYA untuk pair aktif → tidak buang-buang IDB
            // ─────────────────────────────────────────────────────
            if (msg.type === "tick" && msg.symbol) {
                const sym   = msg.symbol;
                const price = msg.price;
                const vol   = msg.v || 1.0;
                const time  = msg.time || msg.t || 0;

                // FIX 1: SELALU kirim ke WASM untuk Market Watch — tidak peduli isDownloading
                // isDownloading hanya relevan untuk candle chart, bukan untuk price display
                // C++ aman: UpdateTick() semua sym, candle hanya terbentuk kalau ada tab
                sendTickToWasm(sym, price, vol, time);

                // IDB hanya untuk pair yang sedang aktif / ada tabnya
                if (sym === CURRENT_SYMBOL || downloadedSymbols.has(sym)) {
                    addToBuffer(sym, [{ time, o: price, h: price, l: price, c: price, v: vol }]);
                }
                return;
            }

            // ─────────────────────────────────────────────────────
            // C. BAR CLOSE
            // ─────────────────────────────────────────────────────
            if (msg.type === "bar" || msg.type === "active_bar") {
                if (!msg.symbol) return;
                const sym = msg.symbol;
                const c   = { time: msg.time, o: msg.open, h: msg.high, l: msg.low, c: msg.close, v: msg.v };

                // 🔥 IDB hanya untuk symbol yg user pernah buka di chart
                // Market Watch harga → dari tick live stream (wasm_push_tick), TIDAK perlu IDB
                if (downloadedSymbols.has(sym)) {
                    addToBuffer(sym, [c]);
                }

                // sendTickToWasm untuk MW tidak perlu downloadedSymbols guard
                // Tapi notifyWASM_candle + bar close logic tetap hanya untuk pair aktif
                sendTickToWasm(sym, c.c, c.v || 1, c.time);

                if (downloadedSymbols.has(sym) && !isDownloading) {

                    if (sym === CURRENT_SYMBOL) {
                        notifyWASM_candle(c.o, c.h, c.l, c.c, c.time, c.v);
                        if (c.time > lastWasmTime) lastWasmTime = c.time;

                        // 🆕 V16: Delegasikan ke orderflow.js — tidak ada logika crypto inline di sini
                        // handleOrderFlowBarClose sudah punya guard isCrypto sendiri
                        if (window.handleOrderFlowBarClose) window.handleOrderFlowBarClose(sym);

                    } else {
                        // Non-primary tab: route bar close ke symbol yang aktif di tab lain
                        if (Module._wasm_push_candle_for_symbol) {
                            Module.ccall('wasm_push_candle_for_symbol', null,
                                ['string','number','number','number','number','number','number'],
                                [sym, c.o, c.h, c.l, c.c, c.time, c.v || 1]);
                        }
                    }
                }
                return;
            }

            // ─────────────────────────────────────────────────────
            // D. GAP DATA (background sync, tidak blokir UI)
            // ─────────────────────────────────────────────────────
            if (msg.type === "gap_data") { handleGapData(msg); return; }

            // ─────────────────────────────────────────────────────
            // E+F. ORDER FLOW — dispatch ke websocket_orderflow.js
            // ─────────────────────────────────────────────────────
            if (window.handleOrderFlowMessage && window.handleOrderFlowMessage(msg)) return;

        } catch (e) { console.error('[WS] Parse error:', e); }
    };

    ws.onclose = () => {
        logWarn('[WS] Disconnected');
        isWSConnected = false;
        isRendering   = false;
        flushBuffer();
        hideLoadingOverlay();
        isDownloading = false;
        // FP cache di-clear saat disconnect — WASM data hilang saat reconnect
        if (window.clearAllFP) window.clearAllFP();
        setTimeout(connectWS, 3000);
    };
}

// =========================================================
// 8. STARTUP
// =========================================================
var Module = Module || {};

Module.onRuntimeInitialized = async function() {
    logGood('[WASM] 🚀 RUNTIME INITIALIZED!');
    isWasmReady = true;

    ['status','spinner','progress'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });

    // 🔥 GUEST MODE: Sembunyikan login gateway, tampilkan canvas langsung
    const gateway = document.getElementById('login-gateway');
    if (gateway) gateway.style.display = 'none';
    const cv = document.getElementById('canvas');
    if (cv) { cv.style.opacity = '1'; cv.focus(); }
    if (Module._wasm_on_login_success) Module._wasm_on_login_success();

    await initIndexedDB();

    const MIN = 500; // konsisten dengan SetActiveSymbol
    // Market Watch akan dapat price dari tick stream live (wasm_push_tick)
    // Hanya cek pair yang ada di IDB untuk downloadedSymbols tracking
    const allKeys = await getAllSymbolsInDB(); // cek siapa yang sudah tersimpan
    const nowEpochStartup = Math.floor(Date.now() / 1000);
    for (const sym of allKeys) {
        downloadedSymbols.add(sym);
        // 🔍 Scan IDB per symbol: tampilkan oldest~latest + gap sebelum user pilih
        try {
            const candles = await getAllCandlesFromDB(sym);
            if (candles.length > 0) {
                const oldest    = candles.reduce((min, c) => c.time < min ? c.time : min, candles[0].time);
                const latest    = candles.reduce((max, c) => c.time > max ? c.time : max, 0);
                const gapSec    = nowEpochStartup - latest;
                const gapMin    = Math.floor(gapSec / 60);
                const oldestStr = new Date(oldest * 1000).toISOString().slice(0,16).replace('T',' ');
                const latestStr = new Date(latest * 1000).toISOString().slice(0,16).replace('T',' ');
                if (gapMin > 1) {
                    logWarn(`[STARTUP] ${sym}: ${candles.length} candles | ${oldestStr} ~ ${latestStr} | gap: ~${gapMin}m ⚠️`);
                    // 🔥 BG-GAP hanya untuk symbol yg user pernah buka di chart
                    // Symbol masuk IDB hanya via downloadedSymbols → aman untuk scaling
                    // (Market Watch price tidak butuh IDB, dapat dari tick live)
                    if (downloadedSymbols.has(sym)) {
                        // Catat di memory — request hanya saat user pilih symbol ini
                        g_startupGapMap.set(sym, latest);
                    }
                    // Symbol lain (masuk IDB karena bar close) → tidak di-cache gap
                } else {
                    logGood(`[STARTUP] ${sym}: ${candles.length} candles | ${oldestStr} ~ ${latestStr} | gap: fresh ✅`);
                }
            } else {
                logInfo(`[STARTUP] ${sym}: IDB kosong`);
            }
        } catch(e) {
            logInfo(`[STARTUP] ${sym}: IDB ✓ (scan error)`);
        }
    }

    if (CURRENT_SYMBOL) {
        // Reconnect / reload — CURRENT_SYMBOL sudah ada, load langsung
        const existing = await getAllCandlesFromDB(CURRENT_SYMBOL);
        if (existing.length >= MIN) {
            // Gap check sebelum render (sama seperti SetActiveSymbol)
            const latestTime = existing.reduce((max, c) => c.time > max ? c.time : max, 0);
            const nowEpoch   = Math.floor(Date.now() / 1000);
            const gapSeconds = nowEpoch - latestTime;
            if (gapSeconds > 30) {
                const gapMinutes = Math.floor(gapSeconds / 60);
                logWarn(`[STARTUP-GAP] ${gapMinutes}m gap → prefill sebelum render`);
                showLoadingOverlay(`Syncing ${CURRENT_SYMBOL} (${gapMinutes}m gap)...`, 0);
                await prefillGapBeforeRender(CURRENT_SYMBOL, latestTime);
                logGood(`[STARTUP-GAP] ✅ IDB lengkap → render`);
            }
            showLoadingOverlay(`Loading ${CURRENT_SYMBOL}`, 0);
            await rebuildFullFromDB(CURRENT_SYMBOL);
            hideLoadingOverlay();
        }
    } else {
        logInfo("[STARTUP] Menunggu user pilih symbol dari picker...");
        hideLoadingOverlay();
        // V17: tidak ada ninja — Market Watch hidup dari tick stream
    }

    connectWS();
};

window.addEventListener('beforeunload', () => flushBuffer());
setInterval(() => { if (candleBuffer.length > 0) flushBuffer(); }, 10000);

// =========================================================
// 9. LOAD SYMBOL UNTUK TAB NON-UTAMA (dari IDB langsung)
// 🆕 V16: Ganti sleep(1) → rAF, sama seperti rebuildFullFromDB
// =========================================================
window.LoadTabSymbol = async function(tabId, symbol) {
    g_tabSymbolMap.set(tabId, symbol);  // 🔥 track symbol tab ini
    resetTabLazy(tabId);                // 🔥 reset lazy state — symbol baru, history belum diketahui
    logInfo(`[TAB${tabId}] LoadTabSymbol: ${symbol}`);

    const MIN     = 100;
    const candles = await getAllCandlesFromDB(symbol);

    if (candles.length >= MIN) {
        logGood(`[TAB${tabId}] IDB hit: ${candles.length} bars -> render langsung`);
        candles.sort((a, b) => a.time - b.time);

        if (Module._wasm_push_candle_for_tab) {
            if (Module._wasm_clear_tab) {
                Module._wasm_clear_tab(tabId);
                logInfo(`[TAB${tabId}] Old data cleared, isLoading=true`);
            }

            // 🔥 V2: Push ALL candles atomically — no rAF yield
            // Yield di tengah push menyebabkan render loop jalan dengan data partial
            for (const c of candles) {
                Module.ccall('wasm_push_candle_for_tab', null,
                    ['number','number','number','number','number','number','number'],
                    [tabId, c.o, c.h, c.l, c.c, c.time, c.v || 1]);
            }
            logGood(`[TAB${tabId}] ${candles.length} M1 candles pushed (atomic)`);

            if (Module._wasm_rebuild_htfs_for_tab) Module._wasm_rebuild_htfs_for_tab(tabId);
            logGood(`[TAB${tabId}] ${symbol} siap!`);

            // 🔥 SMART GAP FILL untuk tab non-primary
            // Sama seperti primary tab — threshold 30 detik agar M1 terdeteksi
            {
                const latestTime = candles.reduce((max, c) => c.time > max ? c.time : max, 0);
                const nowEpoch   = Math.floor(Date.now() / 1000);
                const gapSec     = nowEpoch - latestTime;
                if (gapSec > 30) {
                    const gapMin = Math.floor(gapSec / 60);
                    logWarn(`[TAB${tabId}] GAP ${gapMin}m (~${gapMin} candle M1) → sync dari ${new Date(latestTime*1000).toISOString().slice(0,10)}`);
                    g_pendingTabGap.set(symbol, tabId); // route response ke tab ini
                    wsSend({ type: "request_gap", symbol: symbol, from: latestTime, tab_id: tabId });
                } else {
                    logInfo(`[TAB${tabId}] IDB fresh (gap ${gapSec}s), skip gap sync`);
                }
            }
        } else {
            logWarn(`[TAB${tabId}] wasm_push_candle_for_tab belum ada di C++, skip`);
        }

    } else {
        logWarn(`[TAB${tabId}] IDB kosong untuk ${symbol} → download fresh`);
        g_pendingTabGap.set(symbol, tabId); // track: history response untuk tabId ini
        wsSend({ type: "request_sync", symbol: symbol, count: 10000 });
    }
};

// =========================================================
// ══════════════════════════════════════════════════════════════
// 🔥 PREFILL GAP BEFORE RENDER
// Awaitable gap fill: kirim request_gap → tunggu handleGapData
// simpan ke IDB → resolve → lanjut rebuildFullFromDB
// ══════════════════════════════════════════════════════════════
function prefillGapBeforeRender(symbol, fromTime) {
    return new Promise((resolve) => {
        g_prefillResolve = resolve;
        wsSend({ type: "request_gap", symbol, from: fromTime, prefill: true });
        // Timeout safety: kalau server tidak reply dalam 10 detik, lanjut saja
        setTimeout(() => {
            if (g_prefillResolve) {
                logWarn(`[GAP-PREFILL] Timeout 10s → lanjut render tanpa gap`);
                g_prefillResolve = null;
                resolve();
            }
        }, 10000);
    });
}

// 10. HANDLE GAP RESPONSE - candle baru background sync
// =========================================================
async function handleGapData(msg) {
    if (!msg.symbol) return;
    const sym   = msg.symbol;
    const count = msg.candles ? msg.candles.length : 0;

    // ── 🔥 PREFILL MODE: gap fill sebelum render pertama ──────────────────────
    // Kalau g_prefillResolve ada, ini adalah response untuk prefillGapBeforeRender.
    // Simpan ke IDB → resolve Promise → rebuildFullFromDB akan dipanggil setelah ini.
    if (g_prefillResolve) {
        const resolver = g_prefillResolve;
        g_prefillResolve = null;
        if (count > 0) {
            logGood(`[GAP-PREFILL] ${sym}: +${count} candles → simpan ke IDB`);
            addToBuffer(sym, msg.candles);
            await flushBuffer();
        } else {
            logInfo(`[GAP-PREFILL] ${sym}: up-to-date, tidak ada candle baru`);
        }
        resolver(); // lanjutkan rebuildFullFromDB
        return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    const pendingTabId = msg.tab_id !== undefined
        ? msg.tab_id
        : g_pendingTabGap.get(sym);

    if (pendingTabId !== undefined) {
        g_pendingTabGap.delete(sym);
        const tabId = pendingTabId;
        if (!count) {
            logInfo(`[TAB${tabId}] GAP ${sym}: up-to-date`);
            return;
        }
        logGood(`[TAB${tabId}] GAP ✅ ${sym}: +${count} candles → IDB rebuild`);
        addToBuffer(sym, msg.candles);
        await flushBuffer();
        await rebuildTabFromDB(tabId, sym);
        return;
    }

    // PRIMARY TAB gap sync
    if (!count) {
        logInfo(`[GAP] ${sym}: up-to-date`);
        // Buka gate lazy — gap sudah konfirmasi tidak ada candle baru
        if (!g_initialLoadDone) {
            g_initialLoadDone = true;
            logInfo(`[INIT] Gap 0 — initial load selesai, lazy diizinkan`);
        }
        return;
    }

    // ══════════════════════════════════════════════════════════════════
    // 🔥 FIX TELEPORT: Incremental push untuk gap kecil (≤ 200 candle)
    //
    // MASALAH LAMA:
    //   handleGapData → save_anchor → clear_chart → rebuildFull → restore_anchor
    //   Anchor disimpan sebelum gap candles ditambah → idx anchor = posisi LAMA
    //   → setelah rebuild dengan total+N bar, restore ke idx lama → view bukan
    //   di live end → candle "teleport" (lompat beberapa menit ke belakang)
    //
    // FIX BARU (gap ≤ 200 candle = user tidak aktif beberapa jam atau kurang):
    //   Push langsung ke WASM via wasm_push_candle — tidak perlu clear+rebuild.
    //   Gap candles selalu lebih baru dari semua IDB → aman append ke ujung.
    //   View tetap di live end, history tersambung mulus tanpa glitch.
    //
    // Gap besar (> 200 candle = user tidak aktif sangat lama):
    //   Full rebuild tanpa restore anchor lama (biarkan C++ auto-resolve ke live end).
    // ══════════════════════════════════════════════════════════════════
    const GAP_INCREMENTAL_MAX = 200;

    // Simpan ke IDB dulu (selalu, agar IDB selalu lengkap)
    addToBuffer(sym, msg.candles);
    await flushBuffer();

    if (count <= GAP_INCREMENTAL_MAX && sym === CURRENT_SYMBOL) {
        logGood(`[GAP] ${sym}: +${count} candles → incremental push (no rebuild, no teleport)`);

        // Push langsung ke WASM: urutan oldest→newest
        const sortedGap = [...msg.candles].sort((a, b) => a.time - b.time);
        for (const c of sortedGap) {
            const o  = c.o  ?? c.open  ?? c.c ?? c.close;
            const h  = c.h  ?? c.high  ?? c.c ?? c.close;
            const l  = c.l  ?? c.low   ?? c.c ?? c.close;
            const cl = c.c  ?? c.close;
            const t  = c.time;
            const v  = c.v  ?? 1;
            notifyWASM_candle(o, h, l, cl, t, v);
            sendTickToWasm(sym, cl, v, t);
            if (t > lastWasmTime) lastWasmTime = t;
            if (Module._wasm_push_candle_for_symbol) {
                Module.ccall('wasm_push_candle_for_symbol', null,
                    ['string','number','number','number','number','number','number'],
                    [sym, o, h, l, cl, t, v]);
            }
        }
        // Rebuild HTF saja (tanpa clear GPU)
        if (Module._wasm_rebuild_all_htfs) Module._wasm_rebuild_all_htfs();
        logGood(`[GAP] ✅ ${sym}: +${count} candles incremental (history tersambung)`);

    } else if (sym === CURRENT_SYMBOL) {
        // Gap besar → full rebuild, tapi jangan restore anchor lama
        logGood(`[GAP] ${sym}: +${count} candles → full rebuild (gap besar)`);
        if (window._spinnerShow) window._spinnerShow();

        // Update non-primary tabs
        for (const c of msg.candles) {
            sendTickToWasm(sym, c.c||c.close, c.v||1, c.time);
            if (Module._wasm_push_candle_for_symbol) {
                Module.ccall('wasm_push_candle_for_symbol', null,
                    ['string','number','number','number','number','number','number'],
                    [sym, c.o||c.open, c.h||c.high, c.l||c.low,
                     c.c||c.close, c.time, c.v||1]);
            }
        }
        // Rebuild tanpa restore anchor (C++ auto-resolve ke live end via viewCenterIndex=-1)
        if (Module._wasm_clear_chart) Module._wasm_clear_chart();
        await rebuildFullFromDB(sym);
        // Tidak perlu restore_view_anchor: viewCenterIndex=-1 → snap ke live end
        if (window._spinnerHide) window._spinnerHide();
        logGood(`[GAP] ✅ ${sym}: +${count} candles full rebuild`);
    }

    // Buka gate lazy — initial load selesai
    if (!g_initialLoadDone) {
        g_initialLoadDone = true;
        logInfo(`[INIT] Gap selesai — initial load done, lazy diizinkan`);
    }
}
