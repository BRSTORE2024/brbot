const {
    getConfig,
    getProductById,
    createOrder,
    setTransactionMessageIds,
    completeOrder,
    cancelOrder,
    getUsers,
    ensureUserRegistered
} = require('../database');

const {
    makeDynamicQris,
    generateListText,
    getMainKeyboard,
    generateProductDetail,
    getOrderInlineKeyboard,
    generateInvoiceText,
    getInvoiceInlineKeyboard,
    generateCanceledText,
    getCanceledInlineKeyboard,
    generateAdminSuccessText,
    generateDeliveryText
} = require('../formatter');

const { Markup } = require('telegraf');

const customQtySession = new Map();
const qrisCooldownMap = new Map();
let isBroadcasting = false;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper untuk mengeksekusi panggilan API Telegram dengan Auto-Retry saat ETIMEDOUT / Rate Limit
async function callTelegramWithRetry(fn, maxRetries = 4, baseDelayMs = 1500) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            const errCode = err?.code || err?.errno || '';
            const retryAfter = err?.response?.parameters?.retry_after;

            // Jika terkena limit flood 429 dari Telegram, tunggu sesuai instruksi Telegram
            if (retryAfter) {
                await sleep(( Number(retryAfter) + 1 ) * 1000);
                continue;
            }

            // Jika error karena koneksi timeout / reset, coba ulang setelah jeda
            const isNetworkError =
                errCode === 'ETIMEDOUT' ||
                errCode === 'ECONNRESET' ||
                errCode === 'EAI_AGAIN' ||
                errCode === 'ENOTFOUND' ||
                (err?.message && err.message.includes('ETIMEDOUT'));

            if (isNetworkError && attempt < maxRetries) {
                console.warn(`?? [RETRY ${attempt}/${maxRetries}] Koneksi Telegram timeout, mencoba ulang dalam ${baseDelayMs * attempt}ms...`);
                await sleep(baseDelayMs * attempt);
                continue;
            }
            throw err;
        }
    }
    throw lastError;
}

async function triggerAutoPay(accounts) {
    const cfg = getConfig();
    const rawUrl = (cfg.autoPayUrl || '').trim();
    if (!rawUrl) return;

    let endpoint = rawUrl;
    try {
        const parsed = new URL(rawUrl);
        endpoint = `${parsed.protocol}//${parsed.host}/api/trigger-autopay`;
    } catch (e) {
        const base = rawUrl.replace(/\/api\/trigger-autopay\/?$/, '');
        endpoint = `${base}/api/trigger-autopay`;
    }

    try {
        await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accounts })
        });
    } catch (err) {
        console.error('Gagal mengirim data ke server Auto Pay:', err.message);
    }
}

async function deleteTelegramInvoice(bot, trx) {
    if (!bot || !trx || !trx.chatId || !trx.invoiceMessageId) return;
    try {
        await bot.telegram.deleteMessage(trx.chatId, trx.invoiceMessageId);
    } catch (err) {}
}

// Pengiriman pesanan dilengkapi Auto-Retry 5x + Fallback Teks jika upload dokumen gagal
async function deliverOrderToUser(bot, trx) {
    if (!bot || !trx) return;
    const msgText = generateDeliveryText(trx);
    const items = Array.isArray(trx.lockedItems) ? trx.lockedItems : [];

    try {
        if (items.length > 5) {
            const fileBuffer = Buffer.from(items.join('\n'), 'utf-8');
            await callTelegramWithRetry(() =>
                bot.telegram.sendDocument(
                    trx.userId,
                    { source: fileBuffer, filename: `Akun_${trx.trxId}.txt` },
                    {
                        caption: msgText,
                        ...getMainKeyboard()
                    }
                ), 5, 2000
            );
        } else {
            await callTelegramWithRetry(() =>
                bot.telegram.sendMessage(trx.userId, msgText, {
                    ...getMainKeyboard()
                }), 5, 2000
            );
        }
    } catch (err) {
        console.error('Gagal mengirim dokumen produk ke user setelah retry, menjalankan fallback teks:', err.message);
        // FALLBACK: Jika sendDocument tetap gagal karena jaringan lambat, kirim akun via pesan teks
        try {
            const fallbackText =
                `${msgText}\n\n` +
                `DAFTAR AKUN (${items.length} ITEM):\n` +
                items.map((item, idx) => `${idx + 1}. ${item}`).join('\n');

            // Potong per 3800 karakter jika terlalu panjang untuk 1 pesan Telegram
            for (let i = 0; i < fallbackText.length; i += 3800) {
                const chunk = fallbackText.substring(i, i + 3800);
                await callTelegramWithRetry(() =>
                    bot.telegram.sendMessage(trx.userId, chunk, { ...getMainKeyboard() }), 3, 2000
                );
            }
        } catch (fallbackErr) {
            console.error('? Gagal total mengirim produk ke user:', fallbackErr.message);
        }
    }
}

// Fungsi Broadcast terpusat agar Telegram & Web tidak bentrok dan tidak membuat socket timeout
async function runSafeBroadcast(bot, users, text, prefixHeader = '') {
    if (isBroadcasting) {
        return { started: false, error: 'Proses broadcast sebelumnya masih berjalan. Mohon tunggu hingga selesai.' };
    }

    isBroadcasting = true;
    const fullMessage = prefixHeader ? `${prefixHeader}\n\n${text}` : text;

    let successCount = 0;
    let failCount = 0;

    try {
        for (const u of users) {
            try {
                await bot.telegram.sendMessage(u.id, fullMessage);
                successCount++;
            } catch (err) {
                const retryAfter = err?.response?.parameters?.retry_after;
                if (retryAfter) {
                    // Tunggu jika terkena rate-limit dari Telegram lalu coba kirim lagi ke user ini
                    await sleep((Number(retryAfter) + 1) * 1000);
                    try {
                        await bot.telegram.sendMessage(u.id, fullMessage);
                        successCount++;
                    } catch (e2) {
                        failCount++;
                    }
                } else {
                    failCount++;
                }
            }
            // Jeda 100ms (10 pesan/detik) agar soket jaringan longgar dan transaksi pembeli tidak terganggu
            await sleep(100);
        }
    } finally {
        isBroadcasting = false;
    }

    return { started: true, successCount, failCount };
}

function setupUserHandlers(bot) {
    const getAdminId = () => {
        const cfg = getConfig();
        return cfg.adminId ? String(cfg.adminId).trim() : '';
    };

    bot.command('broadcast', async (ctx) => {
        const adminId = getAdminId();
        if (String(ctx.from.id) !== adminId) {
            return ctx.reply('Akses ditolak. Perintah ini khusus untuk Administrator.');
        }

        if (isBroadcasting) {
            return ctx.reply('?? Proses broadcast sebelumnya masih berjalan. Mohon tunggu hingga selesai.');
        }

        const broadcastText = ctx.message.text.replace(/^\/broadcast(@\w+)?\s*/, '').trim();
        if (!broadcastText) {
            return ctx.reply('Format salah!\nGunakan: /broadcast <isi pesan yang ingin dikirim>');
        }

        const users = getUsers();
        if (!users || users.length === 0) {
            return ctx.reply('Belum ada pelanggan terdaftar di database.');
        }

        const targetChatId = ctx.chat.id;
        await ctx.reply(`? Memulai broadcast ke ${users.length} pelanggan di latar belakang...`);

        (async () => {
            const result = await runSafeBroadcast(bot, users, broadcastText);
            if (result.started) {
                await callTelegramWithRetry(() =>
                    bot.telegram.sendMessage(
                        targetChatId,
                        `? Broadcast Selesai!\n- Berhasil: ${result.successCount}\n- Gagal/Diblokir: ${result.failCount}`
                    ), 3, 1500
                ).catch(() => {});
            }
        })();
    });

    bot.start(async (ctx) => {
        ensureUserRegistered({
            id: ctx.from.id,
            username: ctx.from.username,
            first_name: ctx.from.first_name
        });

        customQtySession.delete(ctx.from.id);
        await ctx.reply(generateListText(1), {
            ...getMainKeyboard()
        });
    });

    bot.command('list', async (ctx) => {
        ensureUserRegistered({
            id: ctx.from.id,
            username: ctx.from.username,
            first_name: ctx.from.first_name
        });

        customQtySession.delete(ctx.from.id);
        const args = ctx.message.text.split(' ');
        const page = parseInt(args[1], 10) || 1;
        await ctx.reply(generateListText(page), {
            ...getMainKeyboard()
        });
    });

    bot.command('myid', async (ctx) => {
        await ctx.reply(`ID Telegram Anda: ${ctx.from.id}`, { ...getMainKeyboard() });
    });

    bot.action(/^qty_refresh_(\d+)_(\d+)$/, async (ctx) => {
        const productId = parseInt(ctx.match[1], 10);
        let currentQty = parseInt(ctx.match[2], 10);

        const product = getProductById(productId);
        if (!product) {
            return ctx.answerCbQuery('Produk tidak ditemukan atau sudah tidak tersedia.', { show_alert: true });
        }

        const minOrder = Math.max(1, parseInt(product.minOrder, 10) || 1);
        if (product.stock < minOrder) {
            await ctx.answerCbQuery('Stok produk saat ini tidak mencukupi minimal pembelian.', { show_alert: true });
            return await ctx.deleteMessage().catch(() => {});
        }

        if (currentQty > product.stock) currentQty = product.stock;
        if (currentQty < minOrder) currentQty = minOrder;

        await ctx.answerCbQuery('Informasi produk diperbarui.');
        await ctx.editMessageText(generateProductDetail(product, currentQty), {
            ...getOrderInlineKeyboard(product.id, currentQty, product)
        }).catch(() => {});
    });

    bot.action(/^qty_set_(\d+)_(\d+)$/, async (ctx) => {
        const productId = parseInt(ctx.match[1], 10);
        let targetQty = parseInt(ctx.match[2], 10);

        const product = getProductById(productId);
        if (!product) return ctx.answerCbQuery('Produk tidak ditemukan.', { show_alert: true });

        if (product.stock < targetQty) {
            return ctx.answerCbQuery(`Stok tidak cukup untuk paket grosir ${targetQty} unit (Sisa: ${product.stock}).`, { show_alert: true });
        }

        await ctx.answerCbQuery(`Jumlah diatur ke ${targetQty} unit (Harga Grosir)`);
        await ctx.editMessageText(generateProductDetail(product, targetQty), {
            ...getOrderInlineKeyboard(product.id, targetQty, product)
        }).catch(() => {});
    });

    bot.action(/^qty_(inc|dec)_(\d+)_(\d+)$/, async (ctx) => {
        const type = ctx.match[1];
        const productId = parseInt(ctx.match[2], 10);
        let currentQty = parseInt(ctx.match[3], 10);

        const product = getProductById(productId);
        if (!product) return ctx.answerCbQuery('Produk tidak ditemukan.', { show_alert: true });

        const minOrder = Math.max(1, parseInt(product.minOrder, 10) || 1);

        if (product.stock <= 0 || product.stock < minOrder) {
            await ctx.answerCbQuery('Stok produk telah habis.', { show_alert: true });
            return await ctx.deleteMessage().catch(() => {});
        }

        if (type === 'inc') {
            if (currentQty >= product.stock) return ctx.answerCbQuery(`Maksimal pembelian adalah ${product.stock} unit.`, { show_alert: true });
            currentQty++;
        } else {
            if (currentQty <= minOrder) return ctx.answerCbQuery(`Minimal pembelian adalah ${minOrder} unit.`, { show_alert: true });
            currentQty--;
        }

        if (currentQty > product.stock) currentQty = product.stock;
        if (currentQty < minOrder) currentQty = minOrder;

        await ctx.answerCbQuery();
        await ctx.editMessageText(generateProductDetail(product, currentQty), {
            ...getOrderInlineKeyboard(product.id, currentQty, product)
        }).catch(() => {});
    });

    bot.action(/^qty_custom_(\d+)$/, async (ctx) => {
        const productId = parseInt(ctx.match[1], 10);
        const product = getProductById(productId);
        if (!product) return ctx.answerCbQuery('Produk tidak ditemukan.', { show_alert: true });

        const minOrder = Math.max(1, parseInt(product.minOrder, 10) || 1);
        customQtySession.set(ctx.from.id, productId);
        await ctx.answerCbQuery();
        await ctx.reply(
            `Masukkan jumlah unit yang ingin dibeli untuk produk ${product.name} (Min. Order: ${minOrder}, Stok tersedia: ${product.stock}):\n\nKetik /batal untuk membatalkan.`
        );
    });

    bot.action(/^pay_(\d+)_(\d+)$/, async (ctx) => {
        const userId = ctx.from.id;
        const now = Date.now();
        const COOLDOWN_TIME = 30 * 1000;

        if (qrisCooldownMap.has(userId)) {
            const expirationTime = qrisCooldownMap.get(userId);
            if (now < expirationTime) {
                const remainingSec = Math.ceil((expirationTime - now) / 1000);
                return ctx.answerCbQuery(
                    `Mohon tunggu ${remainingSec} detik sebelum membuat transaksi baru.`,
                    { show_alert: true }
                );
            }
        }

        const productId = parseInt(ctx.match[1], 10);
        const qty = parseInt(ctx.match[2], 10);

        const cfg = getConfig();
        if (!cfg.qrisString) {
            return ctx.answerCbQuery('Sistem pembayaran belum dikonfigurasi.', { show_alert: true });
        }

        const result = createOrder({
            userId: ctx.from.id,
            chatId: ctx.chat.id,
            username: ctx.from.username,
            firstName: ctx.from.first_name,
            productId,
            qty
        });

        if (!result.success) return ctx.answerCbQuery(result.message, { show_alert: true });

        qrisCooldownMap.set(userId, now + COOLDOWN_TIME);

        const trx = result.transaction;
        const dynamicQrisString = makeDynamicQris(cfg.qrisString, trx.totalPrice);
        const qrUrl = `https://quickchart.io/qr?text=${encodeURIComponent(dynamicQrisString)}&size=400&margin=2`;

        await ctx.answerCbQuery('Memproses invoice...').catch(() => {});
        await ctx.deleteMessage().catch(() => {});

        let sentMsg;
        try {
            sentMsg = await callTelegramWithRetry(() =>
                ctx.replyWithPhoto(qrUrl, {
                    caption: generateInvoiceText(trx),
                    ...getInvoiceInlineKeyboard(trx.trxId)
                }), 3, 1500
            );
        } catch (err) {
            cancelOrder(trx.trxId, 'CANCELED');
            qrisCooldownMap.delete(userId);
            return await ctx.reply('Gagal membuat kode QRIS pembayaran. Stok telah dikembalikan, silakan coba lagi.', {
                ...getMainKeyboard()
            });
        }

        setTransactionMessageIds(trx.trxId, {
            chatId: ctx.chat.id,
            invoiceMessageId: sentMsg.message_id
        });

        const adminId = getAdminId();
        if (adminId) {
            const notifAdmin =
                `PESANAN BARU\n` +
                `====================================\n\n` +
                `No. Invoice  : ${trx.trxId}\n` +
                `Pelanggan    : ${trx.firstName} (@${trx.username || '-'})\n` +
                `ID Telegram  : ${trx.userId}\n` +
                `Layanan      : ${trx.productName} (x${trx.qty})\n` +
                `Total Tagihan: Rp${trx.totalPrice.toLocaleString('id-ID')}`;

            const sentAdmin = await bot.telegram.sendMessage(adminId, notifAdmin, {
                ...Markup.inlineKeyboard([
                    [
                        Markup.button.callback('Setujui', `admin_acc_${trx.trxId}`),
                        Markup.button.callback('Batalkan', `admin_cancel_${trx.trxId}`)
                    ]
                ])
            }).catch(() => null);

            if (sentAdmin) {
                setTransactionMessageIds(trx.trxId, {
                    adminMessageId: sentAdmin.message_id
                });
            }
        }
    });

    bot.action(/^cancel_trx_(.+)$/, async (ctx) => {
        const trxId = ctx.match[1];
        const res = cancelOrder(trxId, 'CANCELED');
        if (!res.success) return ctx.answerCbQuery(res.message, { show_alert: true });

        const trx = res.transaction;
        await ctx.answerCbQuery('Transaksi dibatalkan.');
        await ctx.deleteMessage().catch(() => {});

        await ctx.reply(
            generateCanceledText(trx, 'Dibatalkan oleh pembeli.'),
            { ...getCanceledInlineKeyboard(trx.trxId) }
        ).catch(() => {});

        const adminId = getAdminId();
        if (adminId && trx.adminMessageId) {
            await bot.telegram.deleteMessage(adminId, trx.adminMessageId).catch(() => {});
        }
    });

    bot.action(/^admin_(acc|cancel)_(.+)$/, async (ctx) => {
        const adminId = getAdminId();
        if (String(ctx.from.id) !== adminId) return ctx.answerCbQuery('Akses ditolak.', { show_alert: true });
        const action = ctx.match[1];
        const trxId = ctx.match[2];

        if (action === 'acc') {
            const res = completeOrder(trxId);
            if (!res.success) return ctx.answerCbQuery(res.message, { show_alert: true });

            const trx = res.transaction;
            await deleteTelegramInvoice(bot, trx);
            await deliverOrderToUser(bot, trx);

            if (trx.productName.toLowerCase().includes('youtube')) {
                triggerAutoPay(trx.lockedItems);
            }

            await ctx.answerCbQuery('Transaksi dikonfirmasi.');
            await ctx.editMessageText(generateAdminSuccessText(trx)).catch(() => {});
        } else {
            const res = cancelOrder(trxId, 'CANCELED');
            if (!res.success) return ctx.answerCbQuery(res.message, { show_alert: true });

            const trx = res.transaction;
            await deleteTelegramInvoice(bot, trx);

            await bot.telegram.sendMessage(
                trx.userId,
                generateCanceledText(trx, 'Dibatalkan oleh administrator.'),
                { ...getCanceledInlineKeyboard(trx.trxId) }
            ).catch(() => {});

            await ctx.answerCbQuery('Transaksi dibatalkan.');
            await ctx.deleteMessage().catch(() => {});
        }
    });

    bot.action('close_order', async (ctx) => {
        customQtySession.delete(ctx.from.id);
        await ctx.answerCbQuery('Menu ditutup.');
        await ctx.deleteMessage().catch(() => {});

        await ctx.reply(generateListText(1), {
            ...getMainKeyboard()
        });
    });

    bot.command('batal', async (ctx) => {
        customQtySession.delete(ctx.from.id);
        await ctx.reply('Aksi telah dibatalkan.', { ...getMainKeyboard() });
    });

    bot.on('text', async (ctx) => {
        ensureUserRegistered({
            id: ctx.from.id,
            username: ctx.from.username,
            first_name: ctx.from.first_name
        });

        const text = ctx.message.text.trim();
        if (text.startsWith('/')) return;

        if (text === 'Katalog Produk') {
            customQtySession.delete(ctx.from.id);
            return await ctx.reply(generateListText(1), { ...getMainKeyboard() });
        }

        if (text === 'Cek ID Telegram') {
            return await ctx.reply(`ID Telegram Anda: ${ctx.from.id}`, { ...getMainKeyboard() });
        }

        if (text === 'Bantuan') {
            return await ctx.reply(
                `PANDUAN PEMBELIAN\n\n` +
                `1. Pilih layanan melalui Katalog Produk.\n` +
                `2. Ketik nomor urut layanan (contoh: 1) untuk melihat detail dan memilih jumlah.\n` +
                `3. Lakukan pembayaran QRIS sesuai nominal tagihan yang tertera.\n` +
                `4. Pesanan dan detail akun akan dikirim otomatis setelah pembayaran sukses.`,
                { ...getMainKeyboard() }
            );
        }

        if (text === 'Kontak Admin') {
            return await ctx.reply(
                `LAYANAN DUKUNGAN / BANTUAN\n\n` +
                `Jika Anda mengalami kendala transaksi atau membutuhkan bantuan lebih lanjut, silakan hubungi tim dukungan melalui kontak resmi toko.`,
                { ...getMainKeyboard() }
            );
        }

        if (customQtySession.has(ctx.from.id)) {
            const productId = customQtySession.get(ctx.from.id);
            const customQty = parseInt(text, 10);

            if (isNaN(customQty) || customQty < 1) {
                return ctx.reply('Masukkan format angka yang valid atau ketik /batal untuk membatalkan.');
            }

            const product = getProductById(productId);
            if (!product) {
                customQtySession.delete(ctx.from.id);
                return ctx.reply('Layanan tidak tersedia.');
            }

            const minOrder = Math.max(1, parseInt(product.minOrder, 10) || 1);
            if (customQty < minOrder) {
                return ctx.reply(`Minimal pembelian untuk layanan ${product.name} adalah ${minOrder} unit.`);
            }

            if (customQty > product.stock) {
                return ctx.reply(`Stok tidak mencukupi. Sisa stok tersedia: ${product.stock} unit.`);
            }

            customQtySession.delete(ctx.from.id);
            return await ctx.reply(generateProductDetail(product, customQty), {
                ...getOrderInlineKeyboard(product.id, customQty, product)
            });
        }

        if (/^\d+$/.test(text)) {
            const id = parseInt(text, 10);
            const product = getProductById(id);

            if (product) {
                const minOrder = Math.max(1, parseInt(product.minOrder, 10) || 1);
                if (product.stock <= 0 || product.stock < minOrder) {
                    return await ctx.reply(
                        `Mohon maaf, stok untuk layanan ${product.name} sedang kosong atau kurang dari minimal pembelian (${minOrder} unit).`,
                        { ...getMainKeyboard() }
                    );
                }

                return await ctx.reply(generateProductDetail(product, minOrder), {
                    ...getOrderInlineKeyboard(product.id, minOrder, product)
                });
            } else {
                return await ctx.reply(`Layanan dengan nomor [${id}] tidak ditemukan.`, {
                    ...getMainKeyboard()
                });
            }
        }

        await ctx.reply('Gunakan tombol Katalog Produk atau perintah /list untuk melihat daftar layanan.', {
            ...getMainKeyboard()
        });
    });
}

module.exports = {
    setupUserHandlers,
    deleteTelegramInvoice,
    deliverOrderToUser,
    triggerAutoPay,
    runSafeBroadcast,
    isBroadcastingActive: () => isBroadcasting
};