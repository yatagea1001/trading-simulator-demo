console.log("%c[JS] V14 - ORDER FLOW / FOOTPRINT EDITION", "color: #FF00FF; font-weight:bold; background: #0B0E11; padding: 4px;");
const WS_URL = "ws://127.0.0.1:8765";

// =========================================================
// 1. STATE
// =========================================================
const ALL_SYMBOLS = ["XAUUSD","EURUSD","GBPUSD","BTCUSDT","ETHUSDT"]; 
let CURRENT_SYMBOL = "XAUUSD";
let lastWasmTime = 0;
var isWasmReady = false;
var isWSConnected = false;
let isDownloading = false;
let pendingSymbolSwitch = null;
let downloadedSymbols  = new Set(); 
let downloadedCandles  = [];        
let candleBuffer       = [];        

// 🥷 NINJA PRE-FETCH VARIABLES
let prefetchQueue  = [];
let isPrefetching  = false;
let prefetchBuffer = [];

function logInfo(m) { console.log ("%c" + m, "color:#0af"); }
function logGood(m) { console.log ("%c" + m, "color:#0f0;font-weight:bold"); }
function logWarn(m) { console.warn("%c" + m, "color:orange;font-weight:bold"); }
function logErr (m) { console.error("%c"+ m, "color:red;font-weight:bold"); }

// =========================================================
// 🆕 WASM BRIDGE (TICK, CANDLE, & FOOTPRINT)
// =========================================================
function sendTickToWasm(symbol, price, vol, time) {
    if (!isWasmReady || !Module || !Module.ccall) return;
    Module.ccall('wasm_push_tick', null, ['string', 'number', 'number', 'number'], [symbol, price, vol, time]);
}

function notifyWASM_candle(o, h, l, c, t, v) {
    if (!isWasmReady || !Module || !Module.ccall) return;
    Module.ccall('wasm_push_candle', null, ['number','number','number','number','number','number'], [o, h, l, c, t, v]);
}

function notifyWASM_footprint(time, price, buy_vol, sell_vol) {
    if (!isWasmReady || !Module || !Module.ccall) return;
    Module.ccall(
        'wasm_push_footprint', 
        null, 
        ['number', 'number', 'number', 'number'], 
        [time, price, buy_vol, sell_vol]
    );
}

// 🔥 FUNGSI BARU: Format volume USD jadi string pendek (sama dgn C++ FormatVolumeUSD)
// 36000000 → "36.0M" | 312000 → "312K" | 850 → "850"
function fmtUSD(val) {
    const abs = Math.abs(val);
    const sign = val < 0 ? '-' : '';
    if (abs >= 1e9) return `${sign}${(abs/1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `${sign}${(abs/1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${sign}${(abs/1e3).toFixed(0)}K`;
    return `${sign}${abs.toFixed(0)}`;
}

// =========================================================
// 🥷 NINJA BACKGROUND PRE-FETCH PROCESSOR
// =========================================================
function processPrefetchQueue() {
    if (!isWSConnected || ws.readyState !== WebSocket.OPEN) return;
    if (isDownloading) return; 
    
    if (prefetchQueue.length === 0) {
        logGood("🥷 [NINJA] Selesai! Semua simbol sudah siap di harddisk lokal.");
        return;
    }

    const nextSym = prefetchQueue.shift(); 
    logInfo(`🥷 [NINJA] Mendownload history ${nextSym} diam-diam di latar belakang...`);
    
    isPrefetching = true;
    prefetchBuffer = [];
    wsSend({ type: "request_sync", symbol: nextSym });
}

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
            color:#FF00FF;font-family:'Segoe UI',sans-serif;pointer-events:none;`;
        ov.innerHTML = `
            <div style="text-align:center">
              <div id="ov-msg"  style="font-size:18px;font-weight:bold;margin-bottom:20px">Loading...</div>
              <div style="width:320px;height:8px;background:#222;border-radius:4px;overflow:hidden;margin-bottom:10px">
                <div id="ov-bar" style="width:0%;height:100%;background:linear-gradient(90deg,#FF00FF,#0af);transition:width .3s"></div>
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

function updateProgress(current, total, phase) {
    const pct = total > 0 ? (current / total) * 100 : 0;
    const bar = document.getElementById('ov-bar');
    const msg = document.getElementById('ov-msg');
    const det = document.getElementById('ov-detail');
    if (bar) bar.style.width  = pct + '%';
    if (msg) msg.innerText    = `${phase} ${CURRENT_SYMBOL}`;
    if (det) det.innerText    = `${current.toLocaleString()} / ${total.toLocaleString()} candles`;
}

// =========================================================
// 3. SWITCH PAIR
// =========================================================
window.SetActiveSymbol = async function(newSym) {
    if (isDownloading) {
        pendingSymbolSwitch = newSym;
        return;
    }

    if (isPrefetching) {
        isPrefetching = false;
        prefetchBuffer = [];
    }

    if (CURRENT_SYMBOL === newSym && isWasmReady) return;

    logInfo(`[UI] Switching: ${CURRENT_SYMBOL} → ${newSym}`);
    await flushBuffer();

    CURRENT_SYMBOL = newSym;
    lastWasmTime   = 0;

    if (Module && Module._wasm_clear_chart) Module._wasm_clear_chart();

    const MIN = 1000;
    const existing = await getAllCandlesFromDB(CURRENT_SYMBOL);

    if (existing.length >= MIN) {
        showLoadingOverlay(`Loading ${CURRENT_SYMBOL} from cache`, 0);

        const latestTime  = Math.max(...existing.map(c => c.time));
        const gapMinutes  = (Math.floor(Date.now() / 1000) - latestTime) / 60;

        if (gapMinutes > 5) {
            isDownloading = true;
            wsSend({ type: "request_sync", symbol: CURRENT_SYMBOL });
        } else {
            updateProgress(existing.length, existing.length, "Rendering");
            await rebuildFullFromDB(CURRENT_SYMBOL);
            hideLoadingOverlay();
            
            // 🔥 Minta Order Flow ke Server untuk 500 candle terakhir
            wsSend({ type: "request_footprint", symbol: CURRENT_SYMBOL, count: 500 });
            
            setTimeout(processPrefetchQueue, 1500); 
        }
    } else {
        showLoadingOverlay(`Downloading ${CURRENT_SYMBOL} history`, 0);
        isDownloading = true;
        wsSend({ type: "request_sync", symbol: CURRENT_SYMBOL });
    }
};

// =========================================================
// 5. INDEXEDDB
// =========================================================
let db = null;
const DB_NAME   = 'TradingAppDB';
const DB_VER    = 2;
const STORE     = 'multi_candles';

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

async function saveBufferToDB(data) {
    if (!db || !data.length) return;
    return new Promise(res => {
        const t = db.transaction([STORE], 'readwrite');
        const s = t.objectStore(STORE);
        data.forEach(item => s.put(item));
        t.oncomplete = () => res();
        t.onerror    = e  => console.error('[DB] Save error:', e);
    });
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
// =========================================================
async function rebuildFullFromDB(symbol) {
    if (!isWasmReady) return;

    const candles = await getAllCandlesFromDB(symbol);
    if (!candles.length) return;

    candles.sort((a, b) => a.time - b.time);

    const BATCH = 5000;
    for (let i = 0; i < candles.length; i += BATCH) {
        const batch = candles.slice(i, i + BATCH);
        for (const c of batch) {
            notifyWASM_candle(c.o, c.h, c.l, c.c, c.time, c.v);
            if (c.time > lastWasmTime) lastWasmTime = c.time;
        }
        updateProgress(Math.min(i + BATCH, candles.length), candles.length, "Rendering");
        await new Promise(r => setTimeout(r, 10));
    }

    if (Module._wasm_rebuild_all_htfs) Module._wasm_rebuild_all_htfs();
    downloadedSymbols.add(symbol);
}

// =========================================================
// 7. WEBSOCKET HELPER
// =========================================================
let ws = null;

function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
    }
}

async function connectWS() {
    if (isWSConnected || ws) return;
    isWSConnected = true;
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        logGood('[WS] Connected!');
        ws.send(JSON.stringify({ type: "init", email: "TRADER_CLIENT" }));

        showLoadingOverlay(`Downloading ${CURRENT_SYMBOL} history`, 0);
        isDownloading     = true;
        downloadedCandles = [];
        wsSend({ type: "request_sync", symbol: CURRENT_SYMBOL });

        setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), 30000);
    };

    ws.onmessage = async evt => {
        try {
            const msg = JSON.parse(evt.data);

            // ─────────────────────────────────────────────────────
            // 🔥 A. MENANGKAP DATA ORDER FLOW / FOOTPRINT
            // ─────────────────────────────────────────────────────
            if (msg.type === "footprint_data" && msg.symbol === CURRENT_SYMBOL) {
                const fpArray = msg.data;
                logGood(`📥 [ORDER FLOW] Menerima ${fpArray.length} candle footprint untuk ${CURRENT_SYMBOL}`);

                let totalLevels  = 0;
                let totalVolUSD  = 0;

                for (const fp of fpArray) {
                    for (const lvl of fp.levels) {
                        // Suntik setiap level (buy/sell volume dalam USD asli)
                        notifyWASM_footprint(fp.time, lvl.p, lvl.b, lvl.s);
                        totalLevels++;
                        totalVolUSD += (lvl.b || 0) + (lvl.s || 0);
                    }
                }

                // Log ringkasan volume total (format M/K seperti di chart)
                logGood(`✅ [ORDER FLOW] ${totalLevels} levels | Total Vol: $${fmtUSD(totalVolUSD)} | OK`);
                return;
            }

            // ─────────────────────────────────────────────────────
            // B. HISTORY DOWNLOAD (Main Chart & Ninja)
            // ─────────────────────────────────────────────────────
            if (msg.type === "history" && msg.symbol) {
                const sym = msg.symbol;
                const chunk = msg.candles || [];

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
                        downloadedCandles = [];
                        
                        // 🔥 SETELAH CHART BERES, MINTA DATA FOOTPRINT
                        wsSend({ type: "request_footprint", symbol: CURRENT_SYMBOL, count: 500 });

                        if (pendingSymbolSwitch) {
                            const next = pendingSymbolSwitch;
                            pendingSymbolSwitch = null;
                            setTimeout(() => window.SetActiveSymbol(next), 300);
                        } else {
                            setTimeout(processPrefetchQueue, 2000);
                        }
                    }
                } 
                else if (isPrefetching) {
                    if (chunk.length) prefetchBuffer.push(...chunk);

                    let done = false;
                    if (msg.chunk_info) {
                        const [cur, tot] = msg.chunk_info.split('/').map(Number);
                        if (cur >= tot) done = true;
                    } else if (!chunk.length && prefetchBuffer.length > 0) {
                        done = true;
                    }

                    if (done) {
                        addToBuffer(sym, prefetchBuffer);
                        flushBuffer(); 
                        downloadedSymbols.add(sym);

                        if (prefetchBuffer.length > 0) {
                            let lastC = prefetchBuffer[prefetchBuffer.length - 1];
                            sendTickToWasm(sym, lastC.c || lastC.close, 1, lastC.time);
                        }

                        prefetchBuffer = [];
                        isPrefetching = false;
                        setTimeout(processPrefetchQueue, 1000);
                    }
                }
                return;
            }

            // ─────────────────────────────────────────────────────
            // B2. TICK_FLOW LIVE — Update footprint real-time per tick
            // Server kirim ini tiap tick asli MT5 masuk (bukan nunggu bar close)
            // ─────────────────────────────────────────────────────
            if (msg.type === "tick_flow" && msg.symbol === CURRENT_SYMBOL) {
                notifyWASM_footprint(
                    msg.bar_time,
                    msg.price,
                    msg.buy_vol,
                    msg.sell_vol
                );
                return;
            }

            // ─────────────────────────────────────────────────────
            // C. TICK LIVE
            // ─────────────────────────────────────────────────────
            if (msg.type === "tick" && msg.symbol) {
                const sym   = msg.symbol;
                const price = msg.price;
                // 🔥 FIX: Ambil volume ASLI dari server (USDT untuk crypto, tick_vol untuk forex)
                // Server sudah kirim field 'v' berisi volume yang benar
                const vol   = msg.v || 1.0;
                const time  = msg.time || msg.t || 0;

                if (downloadedSymbols.has(sym) && !isDownloading) {
                    sendTickToWasm(sym, price, vol, time);
                }
                addToBuffer(sym, [{ time, o: price, h: price, l: price, c: price, v: vol }]);
                return;
            }

            // ─────────────────────────────────────────────────────
            // D. BAR CLOSE
            // ─────────────────────────────────────────────────────
            if (msg.type === "bar" || msg.type === "active_bar") {
                if (!msg.symbol) return;
                const sym = msg.symbol;
                const c   = { time: msg.time, o: msg.open, h: msg.high, l: msg.low, c: msg.close, v: msg.v };

                addToBuffer(sym, [c]);

                if (downloadedSymbols.has(sym) && !isDownloading) {
                sendTickToWasm(sym, c.c, c.v, c.time);

                        if (sym === CURRENT_SYMBOL) {
                            notifyWASM_candle(c.o, c.h, c.l, c.c, c.time, c.v);
                            if (c.time > lastWasmTime) lastWasmTime = c.time;

                            // 🔥 SOLUSI HYBRID:
                            // Cek apakah pair ini adalah Crypto (contoh: BTCUSDT, ETHUSDT)
                            // Jika MT5 (XAUUSD, EURUSD), biarkan saja karena sudah punya TICK_FLOW.
                            // Jika Crypto, kita TEMBAK request footprint ke server!
                            if (sym.includes("USDT") || sym === "BTC" || sym === "ETH") {
                                wsSend({ type: "request_footprint", symbol: CURRENT_SYMBOL, count: 0 });
                            }
                        }
                    }
                return;
            }

        } catch (e) { console.error('[WS] Parse error:', e); }
    };

    ws.onclose = () => {
        logWarn('[WS] Disconnected');
        isWSConnected = false;
        flushBuffer();
        hideLoadingOverlay();
        isDownloading = false;
        isPrefetching = false;
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

    await initIndexedDB();

    const MIN = 1000;

    for (const sym of ALL_SYMBOLS) {
        const data = await getAllCandlesFromDB(sym);
        if (data.length >= MIN) {
            downloadedSymbols.add(sym);
            let lastC = data[data.length - 1];
            sendTickToWasm(sym, lastC.c || lastC.close, 1, lastC.time);
        } else if (sym !== CURRENT_SYMBOL) {
            prefetchQueue.push(sym);
        }
    }

    const existing = await getAllCandlesFromDB(CURRENT_SYMBOL);
    if (existing.length >= MIN) {
        showLoadingOverlay(`Loading ${CURRENT_SYMBOL}`, 0);
        await rebuildFullFromDB(CURRENT_SYMBOL);
        hideLoadingOverlay();
        setTimeout(processPrefetchQueue, 2000);
    }

    connectWS();
};

window.addEventListener('beforeunload', () => flushBuffer());
setInterval(() => { if (candleBuffer.length > 0) flushBuffer(); }, 10000);