console.log("%c[WS] Optimized Engine Loading...", "color: cyan; font-weight:bold;");

const WS_URL = "ws://127.0.0.1:8765";

// =====================================================================
// Utility: Log ke CMD (Hanya untuk kejadian penting)
// =====================================================================
function wsLogToCMD(tag, payload = "") {
    // KUNCI: Jangan biarkan log tick/activebar membebani network!
    if (tag === "tick" || tag === "activebar") return;
    
    const url = `/wslog_${tag}${payload ? "_" + payload : ""}`;
    fetch(url).catch(() => {});
}

function logInfo(msg)   { console.log("%c" + msg, "color: #0af;"); }
function logGood(msg)   { console.log("%c" + msg, "color: #0f0; font-weight:bold;"); }
function logWarn(msg)   { console.warn("%c" + msg, "color: orange; font-weight:bold;"); }
function logErr(msg)    { console.error("%c" + msg, "color: red; font-weight:bold;"); }

// =====================================================================
// Reconnect Sistem
// =====================================================================
let reconnectDelay = 1000;
let ws = null;

function connectWS() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        logGood("[WS] Connected to Server");
        wsLogToCMD("connected");
        reconnectDelay = 1000;
    };

    ws.onclose = () => {
        logWarn("[WS] Connection Lost");
        wsLogToCMD("closed");
        setTimeout(() => {
            logInfo(`[WS] Attempting Reconnect...`);
            connectWS();
            reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        }, reconnectDelay);
    };

    ws.onmessage = evt => {
        let msg;
        try { msg = JSON.parse(evt.data); }
        catch (e) { return; }

        // ---------------------------------------------------------
        // 1. HISTORY (Hanya dipanggil saat awal atau ganti pair)
        // ---------------------------------------------------------
        if (msg.type === "history") {
            logInfo(`[WS] Processing ${msg.candles.length} history candles...`);

            for (let c of msg.candles) {
                // Masukkan data M1 ke WASM
                notifyWASM_candle(c.o, c.h, c.l, c.c, c.time, c.v);
            }

            // 🔥 TRIGGER REBUILD HTF:
            // Setelah semua history M1 masuk, kita suruh C++ menghitung M5, H1, dll
            // Agar history di TF besar langsung muncul semua.
            if (Module._wasm_rebuild_all_htfs) {
                Module._wasm_rebuild_all_htfs();
                logGood("[WS] All Timeframes History Rebuilt Successfully");
            }

            wsLogToCMD("history_complete", msg.candles.length);
            return;
        }

        // ---------------------------------------------------------
        // 2. ACTIVE BAR (Penutupan/Pembukaan Candle M1)
        // ---------------------------------------------------------
        if (msg.type === "active_bar") {
            notifyWASM_candle(
                msg.open, msg.high, msg.low, msg.close, 
                msg.time, msg.volume
            );
            return;
        }

        // ---------------------------------------------------------
        // 3. TICK (DATA LIVE - HARUS SANGAT CEPAT)
        // ---------------------------------------------------------
        if (msg.type === "tick") {
            const t = msg.time ?? msg.t ?? 0;
            
            // Panggil fungsi WASM push_tick yang sudah di-optimize (Incremental)
            // Kita tidak pakai notifyWASM_tick agar tidak lewat ccall yang lambat
            if (Module._wasm_push_tick) {
                Module._wasm_push_tick(msg.price, t);
            } else {
                // Fallback jika Module belum siap sempurna
                notifyWASM_tick(msg.price, t);
            }
        }
    };
}

// Inisialisasi koneksi

// =====================================================================
// PROFESSIONAL SESSION STORAGE
// =====================================================================

// Menyimpan email ke browser agar saat refresh tidak hilang
window.saveUserSession = function(email) {
    localStorage.setItem("trader_email", email);
    logGood("[Session] Email saved to local storage");
};

// Mengambil email yang tersimpan (Dipanggil saat start)
window.loadUserSession = function() {
    return localStorage.getItem("trader_email") || "";
};

// Menghapus session saat logout
window.clearUserSession = function() {
    localStorage.removeItem("trader_email");
};
  //connectWS();