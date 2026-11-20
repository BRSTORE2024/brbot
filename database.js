const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DB_PATH = path.join(__dirname, 'data.json');
const USERS_PATH = path.join(__dirname, 'users.json');
const BACKUP_DIR = path.join(__dirname, 'backups');

const defaultData = {
    config: {
        token: '',
        adminId: '',
        storeName: 'BR STORE',
        trxPrefix: 'BR',
        qrisString: '',
        autoPayUrl: 'http://108.136.222.206:4000/api/trigger-autopay'
    },
    products: [],
    transactions: []
};

if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}
if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultData, null, 2));
}
if (!fs.existsSync(USERS_PATH)) {
    fs.writeFileSync(USERS_PATH, JSON.stringify([], null, 2));
}

let lastBackupTime = 0;

function createAutomaticBackup(force = false) {
    const now = Date.now();
    if (!force && now - lastBackupTime < 15 * 60 * 1000) return;
    lastBackupTime = now;

    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

        if (fs.existsSync(DB_PATH)) {
            const dbBackupPath = path.join(BACKUP_DIR, `data_${timestamp}.json`);
            fs.copyFileSync(DB_PATH, dbBackupPath);
        }

        if (fs.existsSync(USERS_PATH)) {
            const usersBackupPath = path.join(BACKUP_DIR, `users_${timestamp}.json`);
            fs.copyFileSync(USERS_PATH, usersBackupPath);
        }

        const files = fs.readdirSync(BACKUP_DIR)
            .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime() }))
            .sort((a, b) => b.time - a.time);

        if (files.length > 40) {
            for (let i = 40; i < files.length; i++) {
                fs.unlinkSync(path.join(BACKUP_DIR, files[i].name));
            }
        }
    } catch (err) {
        console.error('Gagal membuat auto backup lokal:', err);
    }
}

setInterval(() => createAutomaticBackup(true), 6 * 60 * 60 * 1000);

function scheduleDailyTelegramBackup() {
    function getMsToMidnightWIB() {
        const now = new Date();
        const wibTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
        const midnightWIB = new Date(wibTime);
        midnightWIB.setHours(24, 0, 0, 0);
        return Math.max(1000, midnightWIB.getTime() - wibTime.getTime());
    }

    async function sendBackupToTelegram() {
        try {
            const config = getConfig();
            const token = config.token;
            const adminId = config.adminId;

            if (!token || !adminId) {
                console.log('?? [BACKUP] Token bot atau Admin ID belum dikonfigurasi, backup Telegram dilewati.');
                scheduleNextBackup();
                return;
            }

            const dateStr = new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' }).replace(/\//g, '-');
            const zipName = `backup_store_${dateStr}.zip`;
            const zipPath = path.join(__dirname, zipName);

            try {
                execSync(`zip -j "${zipPath}" "${DB_PATH}" "${USERS_PATH}"`);
            } catch (zipErr) {
                console.error('? [BACKUP] Gagal membuat file ZIP, pastikan utilitas zip terinstal di VPS (sudo apt install zip).');
                scheduleNextBackup();
                return;
            }

            if (fs.existsSync(zipPath)) {
                const caption = `?? AUTOMATIC DAILY BACKUP (ZIP)\n?? Tanggal: ${dateStr}\n?? Toko: ${config.storeName || 'BR STORE'}\n?? Berisi arsip data.json & users.json`;

                const formData = new FormData();
                formData.append('chat_id', String(adminId).trim());
                formData.append('caption', caption);
                formData.append('document', new Blob([fs.readFileSync(zipPath)]), zipName);

                await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
                    method: 'POST',
                    body: formData
                });

                fs.unlinkSync(zipPath);
                console.log('? [BACKUP] File backup ZIP berhasil dikirim ke Telegram Admin.');
            }
        } catch (err) {
            console.error('? [BACKUP ERROR] Gagal mengirim backup ZIP ke Telegram:', err.message);
        }

        scheduleNextBackup();
    }

    function scheduleNextBackup() {
        const ms = getMsToMidnightWIB();
        setTimeout(sendBackupToTelegram, ms);
    }

    scheduleNextBackup();
}

scheduleDailyTelegramBackup();

// --- HELPER GROSIR MULTI-TIER ---
function normalizeWholesaleTiers(rawTiers, minQtyDiscount, discountPrice) {
    let tiers = [];
    if (Array.isArray(rawTiers)) {
        tiers = rawTiers
            .map(t => ({
                minQty: Math.max(0, parseInt(t.minQty, 10) || 0),
                price: Math.max(0, parseInt(t.price, 10) || 0)
            }))
            .filter(t => t.minQty > 1 && t.price > 0);
    }

    // Kompatibilitas dengan format 1-level lama
    if (tiers.length === 0) {
        const legacyMin = Math.max(0, parseInt(minQtyDiscount, 10) || 0);
        const legacyPrice = Math.max(0, parseInt(discountPrice, 10) || 0);
        if (legacyMin > 1 && legacyPrice > 0) {
            tiers.push({ minQty: legacyMin, price: legacyPrice });
        }
    }

    // Urutkan dari minQty terkecil ke terbesar & hapus duplikat minQty
    tiers.sort((a, b) => a.minQty - b.minQty);
    const uniqueMap = new Map();
    for (const t of tiers) {
        uniqueMap.set(t.minQty, t.price);
    }
    return Array.from(uniqueMap.entries()).map(([minQty, price]) => ({ minQty, price }));
}

function getUnitPriceForProduct(product, qty) {
    const tiers = normalizeWholesaleTiers(product.wholesaleTiers, product.minQtyDiscount, product.discountPrice);
    let unitPrice = product.price;
    let activeTier = null;

    for (const tier of tiers) {
        if (qty >= tier.minQty) {
            unitPrice = tier.price;
            activeTier = tier;
        }
    }

    return { unitPrice, activeTier, tiers };
}

function readDB() {
    try {
        if (!fs.existsSync(DB_PATH)) {
            fs.writeFileSync(DB_PATH, JSON.stringify(defaultData, null, 2));
            return JSON.parse(JSON.stringify(defaultData));
        }
        const raw = fs.readFileSync(DB_PATH, 'utf-8');
        const data = JSON.parse(raw);
        return {
            config: { ...defaultData.config, ...(data.config || {}) },
            products: Array.isArray(data.products) ? data.products : [],
            transactions: Array.isArray(data.transactions) ? data.transactions : []
        };
    } catch (err) {
        console.error('Error reading DB:', err);
        return JSON.parse(JSON.stringify(defaultData));
    }
}

function writeDB(data) {
    try {
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        createAutomaticBackup(false);
    } catch (err) {
        console.error('Error writing DB:', err);
    }
}

function readUsers() {
    try {
        if (!fs.existsSync(USERS_PATH)) {
            fs.writeFileSync(USERS_PATH, JSON.stringify([], null, 2));
            return [];
        }
        const raw = fs.readFileSync(USERS_PATH, 'utf-8');
        const users = JSON.parse(raw);
        return Array.isArray(users) ? users : [];
    } catch (err) {
        console.error('Error reading users:', err);
        return [];
    }
}

function writeUsers(users) {
    try {
        fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
        createAutomaticBackup(false);
    } catch (err) {
        console.error('Error writing users:', err);
    }
}

function ensureUserRegistered({ id, username, first_name }) {
    if (!id) return null;
    const users = readUsers();
    let user = users.find(u => Number(u.id) === Number(id));
    const nowStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

    if (!user) {
        user = {
            id: Number(id),
            username: username || '-',
            first_name: first_name || 'User',
            balance: 0,
            total_trx: 0,
            joined_at: nowStr
        };
        users.push(user);
        writeUsers(users);
    } else {
        let changed = false;
        const cleanUsername = username || '-';
        const cleanFirstName = first_name || 'User';
        if (user.username !== cleanUsername) { user.username = cleanUsername; changed = true; }
        if (user.first_name !== cleanFirstName) { user.first_name = cleanFirstName; changed = true; }
        if (changed) writeUsers(users);
    }
    return user;
}

function getUsers() {
    return readUsers();
}

function updateUserBalance(userId, amountChange) {
    const users = readUsers();
    const idx = users.findIndex(u => Number(u.id) === Number(userId));
    if (idx === -1) return { success: false, error: 'Pelanggan tidak ditemukan.' };

    const delta = parseInt(amountChange, 10);
    if (isNaN(delta)) return { success: false, error: 'Nominal tidak valid.' };

    users[idx].balance = Math.max(0, (users[idx].balance || 0) + delta);
    writeUsers(users);
    return { success: true, user: users[idx] };
}

function getConfig() {
    return readDB().config;
}

function updateConfig(newCfg) {
    const db = readDB();
    db.config = { ...db.config, ...newCfg };
    writeDB(db);
    return db.config;
}

function getProducts() {
    const db = readDB();
    return db.products.map(p => {
        const wholesaleTiers = normalizeWholesaleTiers(p.wholesaleTiers, p.minQtyDiscount, p.discountPrice);
        return {
            ...p,
            minOrder: Math.max(1, parseInt(p.minOrder, 10) || 1),
            wholesaleTiers,
            minQtyDiscount: wholesaleTiers.length > 0 ? wholesaleTiers[0].minQty : 0,
            discountPrice: wholesaleTiers.length > 0 ? wholesaleTiers[0].price : 0,
            items: Array.isArray(p.items) ? p.items : [],
            stock: Array.isArray(p.items) ? p.items.length : 0
        };
    });
}

function getProductById(id) {
    const products = getProducts();
    return products.find(p => Number(p.id) === Number(id)) || null;
}

function addProduct({ name, price, desc, itemsText, minOrder, wholesaleTiers, minQtyDiscount, discountPrice }) {
    const db = readDB();
    const nextId = db.products.length > 0 ? Math.max(...db.products.map(p => Number(p.id))) + 1 : 1;
    const items = String(itemsText || '')
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean);

    const normalizedTiers = normalizeWholesaleTiers(wholesaleTiers, minQtyDiscount, discountPrice);

    const newProduct = {
        id: nextId,
        name: String(name || '').trim(),
        price: Math.max(0, parseInt(price, 10) || 0),
        desc: String(desc || '-').trim(),
        minOrder: Math.max(1, parseInt(minOrder, 10) || 1),
        wholesaleTiers: normalizedTiers,
        minQtyDiscount: normalizedTiers.length > 0 ? normalizedTiers[0].minQty : 0,
        discountPrice: normalizedTiers.length > 0 ? normalizedTiers[0].price : 0,
        items,
        stock: items.length
    };

    db.products.push(newProduct);
    writeDB(db);
    return newProduct;
}

function updateProduct(id, { name, price, desc, minOrder, wholesaleTiers, minQtyDiscount, discountPrice }) {
    const db = readDB();
    const idx = db.products.findIndex(p => Number(p.id) === Number(id));
    if (idx === -1) return null;

    const normalizedTiers = normalizeWholesaleTiers(wholesaleTiers, minQtyDiscount, discountPrice);

    db.products[idx].name = String(name || db.products[idx].name).trim();
    db.products[idx].price = Math.max(0, parseInt(price, 10) || 0);
    db.products[idx].desc = String(desc || '-').trim();
    db.products[idx].minOrder = Math.max(1, parseInt(minOrder, 10) || 1);
    db.products[idx].wholesaleTiers = normalizedTiers;
    db.products[idx].minQtyDiscount = normalizedTiers.length > 0 ? normalizedTiers[0].minQty : 0;
    db.products[idx].discountPrice = normalizedTiers.length > 0 ? normalizedTiers[0].price : 0;
    db.products[idx].stock = Array.isArray(db.products[idx].items) ? db.products[idx].items.length : 0;

    writeDB(db);
    return db.products[idx];
}

function deleteProduct(id) {
    const db = readDB();
    const initialLen = db.products.length;
    db.products = db.products.filter(p => Number(p.id) !== Number(id));
    if (db.products.length === initialLen) return false;
    writeDB(db);
    return true;
}

function addStockToProduct(id, itemsText) {
    const db = readDB();
    const idx = db.products.findIndex(p => Number(p.id) === Number(id));
    if (idx === -1) return null;

    const newItems = String(itemsText || '')
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean);

    if (!Array.isArray(db.products[idx].items)) db.products[idx].items = [];
    db.products[idx].items.push(...newItems);
    db.products[idx].stock = db.products[idx].items.length;

    writeDB(db);
    return db.products[idx];
}

function deleteSingleStockItem(productId, itemIndex) {
    const db = readDB();
    const pIdx = db.products.findIndex(p => Number(p.id) === Number(productId));
    if (pIdx === -1) return false;

    const items = db.products[pIdx].items || [];
    if (itemIndex < 0 || itemIndex >= items.length) return false;

    items.splice(itemIndex, 1);
    db.products[pIdx].stock = items.length;
    writeDB(db);
    return true;
}

function takeManualStock(productId, count) {
    const db = readDB();
    const pIndex = db.products.findIndex(p => Number(p.id) === Number(productId));
    if (pIndex === -1) return { success: false, error: 'Layanan tidak ditemukan' };

    const takeCount = parseInt(count, 10);
    if (isNaN(takeCount) || takeCount <= 0) return { success: false, error: 'Jumlah tidak valid' };

    if (!Array.isArray(db.products[pIndex].items)) db.products[pIndex].items = [];
    if (takeCount > db.products[pIndex].items.length) {
        return { success: false, error: `Stok tidak mencukupi. Sisa stok: ${db.products[pIndex].items.length}` };
    }

    const takenItems = db.products[pIndex].items.splice(0, takeCount);
    db.products[pIndex].stock = db.products[pIndex].items.length;
    writeDB(db);

    return { success: true, taken: takenItems };
}

function createOrder({ userId, chatId, username, firstName, productId, qty }) {
    const db = readDB();
    const pIdx = db.products.findIndex(p => Number(p.id) === Number(productId));
    if (pIdx === -1) return { success: false, message: 'Layanan tidak ditemukan.' };

    const product = db.products[pIdx];
    const minOrder = Math.max(1, parseInt(product.minOrder, 10) || 1);
    const orderQty = Math.max(1, parseInt(qty, 10) || 1);

    if (orderQty < minOrder) {
        return { success: false, message: `Minimal pembelian untuk layanan ini adalah ${minOrder} unit.` };
    }

    if (!Array.isArray(product.items) || product.items.length < orderQty) {
        return { success: false, message: `Stok tidak mencukupi. Tersedia: ${product.items ? product.items.length : 0}` };
    }

    const { unitPrice } = getUnitPriceForProduct(product, orderQty);
    const basePrice = unitPrice * orderQty;

    const activeTotals = new Set(db.transactions.filter(t => t.status === 'PENDING').map(t => Number(t.totalPrice)));
    let uniqueCode = Math.floor(Math.random() * 99) + 1;
    let attempts = 0;

    while (activeTotals.has(basePrice + uniqueCode) && attempts < 50) {
        uniqueCode = Math.floor(Math.random() * 99) + 1;
        attempts++;
    }

    if (activeTotals.has(basePrice + uniqueCode)) {
        uniqueCode = 0;
        for (let i = 1; i <= 250; i++) {
            if (!activeTotals.has(basePrice + i)) {
                uniqueCode = i;
                break;
            }
        }
    }

    if (uniqueCode === 0) {
        return { success: false, message: 'Antrean pembayaran untuk nominal ini sedang penuh. Silakan coba beberapa saat lagi.' };
    }

    const totalPrice = basePrice + uniqueCode;
    const lockedItems = product.items.splice(0, orderQty);
    product.stock = product.items.length;

    const prefix = (db.config.trxPrefix || 'BR').toUpperCase();
    const randStr = Math.random().toString(36).substring(2, 5).toUpperCase();
    const timePart = Date.now().toString().slice(-6);
    const trxId = `${prefix}-${timePart}${randStr}`;

    const newTrx = {
        trxId,
        userId: Number(userId),
        chatId: Number(chatId),
        username: username || '-',
        firstName: firstName || 'User',
        productId: product.id,
        productName: product.name,
        qty: orderQty,
        basePrice,
        uniqueCode,
        totalPrice,
        lockedItems,
        status: 'PENDING',
        createdAt: Date.now(),
        invoiceMessageId: null,
        adminMessageId: null
    };

    db.transactions.unshift(newTrx);
    writeDB(db);

    return { success: true, transaction: newTrx };
}

function setTransactionMessageIds(trxId, { chatId, invoiceMessageId, adminMessageId }) {
    const db = readDB();
    const trx = db.transactions.find(t => t.trxId === trxId);
    if (!trx) return false;

    if (chatId !== undefined) trx.chatId = chatId;
    if (invoiceMessageId !== undefined) trx.invoiceMessageId = invoiceMessageId;
    if (adminMessageId !== undefined) trx.adminMessageId = adminMessageId;

    writeDB(db);
    return true;
}

function completeOrder(trxId) {
    const db = readDB();
    const trx = db.transactions.find(t => t.trxId === trxId);
    if (!trx) return { success: false, message: 'Transaksi tidak ditemukan.' };
    if (trx.status === 'SUCCESS') return { success: false, message: 'Transaksi sudah diselesaikan sebelumnya.' };
    if (trx.status !== 'PENDING') return { success: false, message: `Transaksi tidak dapat diselesaikan karena berstatus ${trx.status}.` };

    trx.status = 'SUCCESS';
    trx.completedAt = Date.now();
    writeDB(db);

    const users = readUsers();
    const uIdx = users.findIndex(u => Number(u.id) === Number(trx.userId));
    if (uIdx !== -1) {
        users[uIdx].total_trx = (users[uIdx].total_trx || 0) + 1;
        writeUsers(users);
    }

    return { success: true, transaction: trx };
}

function cancelOrder(trxId, reasonStatus = 'CANCELED') {
    const db = readDB();
    const trx = db.transactions.find(t => t.trxId === trxId);
    if (!trx) return { success: false, message: 'Transaksi tidak ditemukan.' };
    if (trx.status !== 'PENDING') return { success: false, message: `Transaksi sudah berstatus ${trx.status}.` };

    const pIdx = db.products.findIndex(p => Number(p.id) === Number(trx.productId));
    if (pIdx !== -1 && Array.isArray(trx.lockedItems) && trx.lockedItems.length > 0) {
        if (!Array.isArray(db.products[pIdx].items)) db.products[pIdx].items = [];
        db.products[pIdx].items.unshift(...trx.lockedItems);
        db.products[pIdx].stock = db.products[pIdx].items.length;
    }

    trx.status = reasonStatus;
    trx.canceledAt = Date.now();
    writeDB(db);

    return { success: true, transaction: trx };
}

function getTransactions() {
    return readDB().transactions;
}

function getTransactionById(trxId) {
    const db = readDB();
    return db.transactions.find(t => t.trxId === trxId) || null;
}

function findPendingByAmount(amount) {
    const db = readDB();
    return db.transactions.find(t => t.status === 'PENDING' && Number(t.totalPrice) === Number(amount)) || null;
}

function getExpiredPendingTransactions(maxAgeMs = 5 * 60 * 1000) {
    const db = readDB();
    const now = Date.now();
    return db.transactions.filter(t => {
        if (t.status !== 'PENDING') return false;
        const createdTime = Number(t.createdAt);
        if (!createdTime || isNaN(createdTime)) return true;
        return (now - createdTime) >= maxAgeMs;
    });
}

module.exports = {
    readDB,
    writeDB,
    ensureUserRegistered,
    getUsers,
    updateUserBalance,
    getConfig,
    updateConfig,
    getProducts,
    getProductById,
    getUnitPriceForProduct,
    addProduct,
    updateProduct,
    deleteProduct,
    addStockToProduct,
    deleteSingleStockItem,
    takeManualStock,
    createOrder,
    setTransactionMessageIds,
    completeOrder,
    cancelOrder,
    getTransactions,
    getTransactionById,
    findPendingByAmount,
    getExpiredPendingTransactions
};