const express = require('express');
const fs = require('fs');
const path = require('path');
const {
    getConfig,
    updateConfig,
    getProducts,
    addProduct,
    updateProduct,
    deleteProduct,
    addStockToProduct,
    deleteSingleStockItem,
    takeManualStock,
    getTransactions,
    completeOrder,
    cancelOrder,
    findPendingByAmount,
    getUsers,
    updateUserBalance
} = require('./database');

const {
    deleteTelegramInvoice,
    deliverOrderToUser,
    triggerAutoPay,
    runSafeBroadcast,
    isBroadcastingActive
} = require('./handlers/user');

const {
    generateCanceledText,
    getCanceledInlineKeyboard,
    generateAdminSuccessText
} = require('./formatter');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const PORT = process.env.PORT || 3000;

function authMiddleware(req, res, next) {
    const pass = req.headers['x-admin-password'];
    if (!pass || pass !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Password Administrator salah' });
    }
    next();
}

function getServerBBaseUrl() {
    const config = getConfig();
    const rawUrl = (config.autoPayUrl || '').trim();
    if (!rawUrl) return null;
    try {
        const parsed = new URL(rawUrl);
        return `${parsed.protocol}//${parsed.host}`;
    } catch (e) {
        return rawUrl.replace(/\/api\/trigger-autopay\/?$/, '');
    }
}

function startWebServer(botManager) {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.static(path.join(__dirname, 'public')));

    app.get('/', (req, res) => {
        const publicIndex = path.join(__dirname, 'public', 'index.html');
        const rootIndex = path.join(__dirname, 'index.html');
        res.sendFile(fs.existsSync(publicIndex) ? publicIndex : rootIndex);
    });

    app.get('/api/data', authMiddleware, (req, res) => {
        res.json({
            config: getConfig(),
            products: getProducts(),
            transactions: getTransactions(),
            botStatus: botManager ? botManager.getStatus() : { running: false }
        });
    });

    app.get('/api/users', authMiddleware, (req, res) => {
        res.json({ users: getUsers() });
    });

    app.post('/api/users/:id/balance', authMiddleware, (req, res) => {
        const result = updateUserBalance(req.params.id, req.body.amount);
        if (!result.success) return res.status(400).json({ error: result.error });
        res.json({ message: 'Saldo berhasil diperbarui', user: result.user });
    });

    app.post('/api/config', authMiddleware, async (req, res) => {
        const oldConfig = getConfig();
        const updated = updateConfig({
            storeName: req.body.storeName,
            token: req.body.token,
            adminId: req.body.adminId,
            trxPrefix: req.body.trxPrefix,
            qrisString: req.body.qrisString,
            autoPayUrl: req.body.autoPayUrl
        });

        let botStatus = botManager ? botManager.getStatus() : { running: false };
        let warning = false;
        let message = 'Konfigurasi berhasil disimpan';

        if (botManager && updated.token !== oldConfig.token) {
            botStatus = await botManager.restartBot(updated.token);
            if (!botStatus.running) {
                warning = true;
                message = 'Konfigurasi tersimpan, namun token bot tidak valid';
            }
        }

        res.json({ config: updated, botStatus, warning, message });
    });

    // --- ENDPOINT PROXY STATUS & LOGS SERVER B ---
    app.get('/api/serverb/status', authMiddleware, async (req, res) => {
        const baseUrl = getServerBBaseUrl();
        if (!baseUrl) return res.json({ online: false, isRunning: false });

        try {
            const response = await fetch(`${baseUrl}/api/logs`, { method: 'GET' });
            if (response.ok) {
                const data = await response.json();
                return res.json({ online: true, isRunning: !!data.isRunning });
            }
            res.json({ online: false, isRunning: false });
        } catch (e) {
            res.json({ online: false, isRunning: false });
        }
    });

    app.get('/api/serverb/logs', authMiddleware, async (req, res) => {
        const baseUrl = getServerBBaseUrl();
        if (!baseUrl) return res.json({ online: false, logs: ['URL Auto Pay belum diatur di Pengaturan.'], isRunning: false });

        try {
            const response = await fetch(`${baseUrl}/api/logs`, { method: 'GET' });
            if (response.ok) {
                const data = await response.json();
                return res.json({ online: true, logs: data.logs || [], isRunning: !!data.isRunning });
            }
            res.json({ online: false, logs: ['Server B merespons dengan error.'], isRunning: false });
        } catch (err) {
            res.json({ online: false, logs: ['Gagal terhubung ke Server B (' + baseUrl + '). Pastikan receiver.js aktif.'], isRunning: false });
        }
    });

    // --- ENDPOINT PROXY START / STOP SCRIPT PAY DI SERVER B ---
    app.post('/api/serverb/:action', authMiddleware, async (req, res) => {
        const action = req.params.action;
        if (action !== 'start' && action !== 'stop') {
            return res.status(400).json({ error: 'Aksi tidak valid.' });
        }

        const baseUrl = getServerBBaseUrl();
        if (!baseUrl) return res.status(400).json({ error: "URL Auto Pay belum diatur di Pengaturan." });

        try {
            const response = await fetch(`${baseUrl}/api/serverb/control`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action })
            });
            const data = await response.json();
            if (!response.ok) {
                return res.status(response.status).json({ error: data.error || 'Gagal mengeksekusi perintah di Server B' });
            }
            res.json(data);
        } catch (err) {
            res.status(500).json({ error: "Gagal menghubungi Server B: " + err.message });
        }
    });

    // --- ENDPOINT PROXY BACA & SIMPAN FILE AKUN.TXT DI SERVER B ---
    app.get('/api/editor/file', authMiddleware, async (req, res) => {
        const baseUrl = getServerBBaseUrl();
        if (!baseUrl) return res.status(400).json({ error: 'URL Auto Pay belum diatur.' });

        try {
            const response = await fetch(`${baseUrl}/api/check-failed`, { method: 'GET' });
            const data = await response.json();
            const textContent = data.rawContent !== undefined
                ? data.rawContent
                : (Array.isArray(data.accounts) ? data.accounts.join('\n') : '');
            res.json({ content: textContent });
        } catch (err) {
            res.status(500).json({ error: 'Gagal mengambil AKUN.txt dari Server B: ' + err.message });
        }
    });

    app.post('/api/editor/file', authMiddleware, async (req, res) => {
        const baseUrl = getServerBBaseUrl();
        if (!baseUrl) return res.status(400).json({ error: 'URL Auto Pay belum diatur.' });

        try {
            const { content } = req.body;
            const response = await fetch(`${baseUrl}/api/update-akun`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rawContent: content || '' })
            });

            const data = await response.json();
            if (response.ok) {
                res.json({ success: true, message: data.message || 'File AKUN.txt di Server B berhasil disimpan.' });
            } else {
                res.status(500).json({ error: data.error || 'Server B menolak penyimpanan file.' });
            }
        } catch (err) {
            res.status(500).json({ error: 'Gagal menyimpan file ke Server B: ' + err.message });
        }
    });

    // --- ENDPOINT WEB BROADCAST ---
    app.post('/api/broadcast', authMiddleware, async (req, res) => {
        const { message } = req.body;
        if (!message || !message.trim()) {
            return res.status(400).json({ error: 'Pesan broadcast tidak boleh kosong.' });
        }

        if (isBroadcastingActive()) {
            return res.status(400).json({ error: 'Proses broadcast sebelumnya masih berjalan. Tunggu hingga selesai.' });
        }

        const bot = botManager ? botManager.getBot() : null;
        if (!bot) {
            return res.status(400).json({ error: 'Bot Telegram sedang tidak aktif.' });
        }

        const users = getUsers();
        if (!users || users.length === 0) {
            return res.status(400).json({ error: 'Tidak ada pelanggan terdaftar.' });
        }

        (async () => {
            const result = await runSafeBroadcast(bot, users, message.trim(), '?? PENGUMUMAN TOKO');
            if (result.started) {
                console.log(`?? Broadcast Web Selesai. Sukses: ${result.successCount}, Gagal: ${result.failCount}`);
            }
        })();

        res.json({ success: true, message: `Broadcast sedang dikirim ke ${users.length} pelanggan di latar belakang.` });
    });

    // --- ENDPOINT PRODUK & TRANSAKSI ---
    app.post('/api/products', authMiddleware, (req, res) => {
        const product = addProduct(req.body);
        res.json({ product });
    });

    app.put('/api/products/:id', authMiddleware, (req, res) => {
        const product = updateProduct(req.params.id, req.body);
        if (!product) return res.status(404).json({ error: 'Layanan tidak ditemukan' });
        res.json({ product });
    });

    app.delete('/api/products/:id', authMiddleware, (req, res) => {
        const ok = deleteProduct(req.params.id);
        if (!ok) return res.status(404).json({ error: 'Layanan tidak ditemukan' });
        res.json({ message: 'Layanan dihapus' });
    });

    app.post('/api/products/:id/stock', authMiddleware, (req, res) => {
        const product = addStockToProduct(req.params.id, req.body.itemsText);
        if (!product) return res.status(404).json({ error: 'Layanan tidak ditemukan' });
        res.json({ product });
    });

    app.post('/api/products/:id/stock/take', authMiddleware, (req, res) => {
        const result = takeManualStock(req.params.id, req.body.count);
        if (!result.success) return res.status(400).json({ error: result.error });
        res.json({ taken: result.taken });
    });

    app.delete('/api/products/:id/stock/:index', authMiddleware, (req, res) => {
        const ok = deleteSingleStockItem(req.params.id, parseInt(req.params.index, 10));
        if (!ok) return res.status(404).json({ error: 'Item tidak ditemukan' });
        res.json({ message: 'Stok dihapus' });
    });

    app.post('/api/transactions/:trxId/action', authMiddleware, async (req, res) => {
        const { trxId } = req.params;
        const { action } = req.body;
        const bot = botManager ? botManager.getBot() : null;
        const adminId = getConfig().adminId ? String(getConfig().adminId).trim() : '';

        if (action === 'approve') {
            const result = completeOrder(trxId);
            if (!result.success) return res.status(400).json({ error: result.message });

            const trx = result.transaction;
            if (bot) {
                await deleteTelegramInvoice(bot, trx);
                await deliverOrderToUser(bot, trx);

                if (trx.productName.toLowerCase().includes('youtube')) {
                    triggerAutoPay(trx.lockedItems);
                }

                if (adminId) {
                    const successText = generateAdminSuccessText(trx);
                    if (trx.adminMessageId) {
                        const edited = await bot.telegram.editMessageText(
                            adminId,
                            trx.adminMessageId,
                            undefined,
                            successText
                        ).catch(() => null);
                        if (!edited) {
                            await bot.telegram.sendMessage(adminId, successText).catch(() => {});
                        }
                    } else {
                        await bot.telegram.sendMessage(adminId, successText).catch(() => {});
                    }
                }
            }
            return res.json({ message: 'Transaksi berhasil diselesaikan dan produk dikirim' });
        } else if (action === 'cancel') {
            const result = cancelOrder(trxId, 'CANCELED');
            if (!result.success) return res.status(400).json({ error: result.message });

            const trx = result.transaction;
            if (bot) {
                await deleteTelegramInvoice(bot, trx);
                await bot.telegram.sendMessage(
                    trx.userId,
                    generateCanceledText(trx, 'Dibatalkan oleh administrator.'),
                    { ...getCanceledInlineKeyboard(trx.trxId) }
                ).catch(() => {});

                if (adminId && trx.adminMessageId) {
                    await bot.telegram.deleteMessage(adminId, trx.adminMessageId).catch(() => {});
                }
            }
            return res.json({ message: 'Transaksi dibatalkan dan stok dikembalikan' });
        }

        res.status(400).json({ error: 'Aksi tidak valid' });
    });

    app.post('/dana-webhook', async (req, res) => {
        try {
            const text = req.body.message || req.body.text || req.body.title || JSON.stringify(req.body);
            const match = text.match(/(?:Rp|IDR)[\s.]*([\d.]+)(?:,\d{1,2})?/i);
            if (!match) return res.send('Abaikan');

            const amount = parseInt(match[1].replace(/\./g, ''), 10);
            if (isNaN(amount) || amount <= 0) return res.send('Abaikan');

            const pendingTrx = findPendingByAmount(amount);

            if (pendingTrx) {
                const result = completeOrder(pendingTrx.trxId);
                if (result.success) {
                    const trx = result.transaction;
                    const bot = botManager ? botManager.getBot() : null;
                    const adminId = getConfig().adminId ? String(getConfig().adminId).trim() : '';

                    if (bot) {
                        await deleteTelegramInvoice(bot, trx);
                        await deliverOrderToUser(bot, trx);

                        if (trx.productName.toLowerCase().includes('youtube')) {
                            triggerAutoPay(trx.lockedItems);
                        }

                        if (adminId) {
                            const successText = generateAdminSuccessText(trx);
                            if (trx.adminMessageId) {
                                const edited = await bot.telegram.editMessageText(
                                    adminId,
                                    trx.adminMessageId,
                                    undefined,
                                    successText
                                ).catch(() => null);
                                if (!edited) {
                                    await bot.telegram.sendMessage(adminId, successText).catch(() => {});
                                }
                            } else {
                                await bot.telegram.sendMessage(adminId, successText).catch(() => {});
                            }
                        }
                    }
                    return res.send('Sukses');
                }
            }
            return res.send('Not Found');
        } catch (err) {
            return res.status(500).send('Error');
        }
    });

    app.listen(PORT, () => {
        console.log(`?? Web Administrator Panel berjalan di port ${PORT}`);
    });
}

module.exports = { startWebServer };