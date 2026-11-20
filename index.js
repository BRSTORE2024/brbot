const fs = require('fs');
const path = require('path');
const dns = require('dns');
const https = require('https');

// PENTING: Paksa Node.js memprioritaskan IPv4 agar tidak terkena ETIMEDOUT ke api.telegram.org
if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}

// Agent HTTPS khusus dengan Keep-Alive & IPv4 untuk mencegah Socket Exhaustion saat broadcast
const telegramHttpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 10000,
    family: 4,
    maxSockets: 50,
    timeout: 30000
});

// Muat file .env secara otomatis
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    const envLines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
    for (const line of envLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
            const key = trimmed.substring(0, eqIdx).trim();
            const val = trimmed.substring(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
            if (!process.env[key]) process.env[key] = val;
        }
    }
}

const { Telegraf } = require('telegraf');
const {
    getConfig,
    getExpiredPendingTransactions,
    cancelOrder
} = require('./database');
const {
    setupUserHandlers,
    deleteTelegramInvoice
} = require('./handlers/user');
const {
    generateCanceledText,
    getCanceledInlineKeyboard
} = require('./formatter');
const { startWebServer } = require('./web');

let botInstance = null;
let currentToken = '';
let botUsername = '';
let isRunning = false;

async function startBot(token) {
    if (!token) {
        isRunning = false;
        botUsername = '';
        return { running: false, error: 'Token kosong' };
    }

    if (botInstance) {
        try {
            botInstance.stop('RESTART');
        } catch (e) {}
        botInstance = null;
        isRunning = false;
    }

    try {
        // Gunakan telegramHttpsAgent (IPv4 + KeepAlive) dan matikan handlerTimeout
        const bot = new Telegraf(token, {
            handlerTimeout: Infinity,
            telegram: {
                agent: telegramHttpsAgent
            }
        });

        // Tangkap semua error tak terduga agar bot tidak pernah mati
        bot.catch((err, ctx) => {
            console.error(`?? Telegraf error pada update ${ctx?.updateType || 'unknown'}:`, err.message);
        });

        const me = await bot.telegram.getMe();
        botUsername = me.username || 'Bot';

        setupUserHandlers(bot);

        bot.launch().catch(err => {
            console.error('? Bot launch error:', err.message);
            isRunning = false;
        });

        botInstance = bot;
        currentToken = token;
        isRunning = true;
        console.log(`? Bot berhasil berjalan sebagai @${botUsername}`);
        return { running: true, botUsername };
    } catch (err) {
        console.error('? Gagal menjalankan bot:', err.message);
        isRunning = false;
        botUsername = '';
        return { running: false, error: err.message };
    }
}

let isCheckingExpired = false;

// Pemeriksaan transaksi kedaluwarsa (lewat 5 menit) setiap 5 detik
setInterval(async () => {
    if (isCheckingExpired) return;
    isCheckingExpired = true;

    try {
        const expiredList = getExpiredPendingTransactions(5 * 60 * 1000);
        if (expiredList.length === 0) return;

        const cfg = getConfig();
        const adminId = cfg.adminId ? String(cfg.adminId).trim() : '';

        for (const exp of expiredList) {
            const res = cancelOrder(exp.trxId, 'CANCELED');
            if (res.success) {
                const canceledTrx = res.transaction;
                console.log(`? [EXPIRED] Transaksi ${canceledTrx.trxId} otomatis dibatalkan (lewat 5 menit).`);

                if (botInstance) {
                    const targetChatId = canceledTrx.chatId || canceledTrx.userId;

                    if (targetChatId && canceledTrx.invoiceMessageId) {
                        await botInstance.telegram.deleteMessage(targetChatId, canceledTrx.invoiceMessageId).catch(() => {});
                    }

                    await botInstance.telegram.sendMessage(
                        canceledTrx.userId,
                        generateCanceledText(canceledTrx, 'Melewati batas waktu pembayaran 5 menit.'),
                        { ...getCanceledInlineKeyboard(canceledTrx.trxId) }
                    ).catch(() => {});

                    if (adminId && canceledTrx.adminMessageId) {
                        await botInstance.telegram.deleteMessage(adminId, canceledTrx.adminMessageId).catch(() => {});
                    }
                }
            }
        }
    } catch (err) {
        console.error('Error saat memeriksa transaksi expired:', err.message);
    } finally {
        isCheckingExpired = false;
    }
}, 5 * 1000);

const botManager = {
    getBot: () => botInstance,
    getStatus: () => ({ running: isRunning, botUsername }),
    restartBot: async (newToken) => {
        return await startBot(newToken);
    }
};

const initialCfg = getConfig();
if (initialCfg.token) {
    startBot(initialCfg.token);
}

startWebServer(botManager);

process.once('SIGINT', () => { if (botInstance) botInstance.stop('SIGINT'); process.exit(0); });
process.once('SIGTERM', () => { if (botInstance) botInstance.stop('SIGTERM'); process.exit(0); });