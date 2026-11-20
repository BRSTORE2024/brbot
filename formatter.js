const { Markup } = require('telegraf');
const { getProducts, getConfig, getUnitPriceForProduct } = require('./database');

const ITEMS_PER_PAGE = 10;

function crc16(str) {
    let crc = 0xFFFF;
    for (let i = 0; i < str.length; i++) {
        crc ^= str.charCodeAt(i) << 8;
        for (let j = 0; j < 8; j++) {
            if ((crc & 0x8000) > 0) crc = (crc << 1) ^ 0x1021;
            else crc = crc << 1;
        }
    }
    return (crc & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
}

function makeDynamicQris(qris, amount) {
    try {
        const rawQris = String(qris || '').trim();
        const crcIndex = rawQris.lastIndexOf('6304');
        if (crcIndex === -1) return rawQris;

        let qrisTanpaCrc = rawQris.substring(0, crcIndex);
        qrisTanpaCrc = qrisTanpaCrc.replace('010211', '010212');

        let strAmount = Math.floor(Number(amount) || 0).toString();
        let tagAmount = "54" + strAmount.length.toString().padStart(2, '0') + strAmount;

        if (qrisTanpaCrc.includes('5802ID')) {
            qrisTanpaCrc = qrisTanpaCrc.replace('5802ID', tagAmount + '5802ID');
        } else {
            qrisTanpaCrc += tagAmount;
        }

        let newQris = qrisTanpaCrc + "6304";
        return newQris + crc16(newQris);
    } catch (e) {
        return qris;
    }
}

function getFormattedTime() {
    return new Date().toLocaleTimeString('id-ID', {
        timeZone: 'Asia/Jakarta',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }) + ' WIB';
}

function getMainKeyboard() {
    const products = getProducts();

    const rows = [
        ['Katalog Produk', 'Cek ID Telegram'],
        ['Bantuan', 'Kontak Admin']
    ];

    if (products.length > 0) {
        let productRow = [];
        products.forEach((p, index) => {
            productRow.push(String(p.id));
            if (productRow.length === 5 || index === products.length - 1) {
                rows.push(productRow);
                productRow = [];
            }
        });
    }

    return Markup.keyboard(rows).resize();
}

function generateListText(page = 1) {
    const products = getProducts();
    const totalProducts = products.length;

    if (totalProducts === 0) {
        return `KATALOG PRODUK\n\nSaat ini belum ada layanan akun yang tersedia.`;
    }

    const totalPages = Math.ceil(totalProducts / ITEMS_PER_PAGE) || 1;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;

    const startIndex = (page - 1) * ITEMS_PER_PAGE;
    const currentProducts = products.slice(startIndex, startIndex + ITEMS_PER_PAGE);

    let text = `LIST PRODUK\n\n`;

    currentProducts.forEach((p) => {
        text += `[${p.id}] ${p.name} (${p.stock})\n`;
    });

    text += `\nHalaman ${page} dari ${totalPages}\n`;
    text += `${getFormattedTime()}`;

    if (totalPages > 1) {
        text += `\nGunakan perintah /list [halaman] untuk navigasi.`;
    }

    return text;
}

function generateProductDetail(product, qty = 1) {
    const { unitPrice, activeTier, tiers } = getUnitPriceForProduct(product, qty);
    const wholesaleNote = activeTier ? ` (Harga Grosir =${activeTier.minQty})` : '';
    const totalPrice = unitPrice * qty;
    const minOrder = Math.max(1, parseInt(product.minOrder, 10) || 1);

    let text = `Nama Produk: ${product.name}\n`;
    text += `Harga Satuan: Rp${unitPrice.toLocaleString('id-ID')}${wholesaleNote}\n`;

    if (minOrder > 1) {
        text += `Minimal Order: ${minOrder} pcs\n`;
    }

    if (tiers.length > 0) {
        text += `Daftar Harga Grosir:\n`;
        tiers.forEach((t) => {
            const penanda = (activeTier && activeTier.minQty === t.minQty) ? ' ?' : '';
            text += `  -Min. ${t.minQty} pcs -> Rp${t.price.toLocaleString('id-ID')}/pcs${penanda}\n`;
        });
    }

    text += `Stok Tersedia: ${product.stock} Pcs\n`;
    text += `Deskripsi: ${product.desc || '-'}\n\n`;

    text += `Total: ${qty} pcs\n`;
    text += `Subtotal: Rp${totalPrice.toLocaleString('id-ID')}`;

    return text;
}

function getOrderInlineKeyboard(productId, qty, product = null) {
    const p = product || { wholesaleTiers: [] };
    const tiers = Array.isArray(p.wholesaleTiers) ? p.wholesaleTiers : [];

    const buttons = [
        [
            Markup.button.callback('-', `qty_dec_${productId}_${qty}`),
            Markup.button.callback('Segarkan', `qty_refresh_${productId}_${qty}`),
            Markup.button.callback('+', `qty_inc_${productId}_${qty}`)
        ]
    ];

    // Tambahkan tombol pintasan cepat untuk langsung memilih jumlah minimal grosir
    if (tiers.length > 0) {
        const tierButtons = tiers.slice(0, 3).map(t =>
            Markup.button.callback(`Grosir ${t.minQty}x`, `qty_set_${productId}_${t.minQty}`)
        );
        buttons.push(tierButtons);
    }

    buttons.push([Markup.button.callback('Atur Jumlah Custom', `qty_custom_${productId}`)]);
    buttons.push([Markup.button.callback('Bayar via QRIS (Otomatis)', `pay_${productId}_${qty}`)]);
    buttons.push([Markup.button.callback('Kembali', `close_order`)]);

    return Markup.inlineKeyboard(buttons);
}

function generateInvoiceText(trx) {
    let text = `INVOICE PEMBAYARAN\n`;
    text += `====================================\n\n`;
    text += `No. Invoice  : ${trx.trxId}\n`;
    text += `Layanan      : ${trx.productName}\n`;
    text += `Jumlah       : ${trx.qty} pcs\n`;
    text += `Total Tagihan: Rp${trx.totalPrice.toLocaleString('id-ID')}\n\n`;
    text += `====================================\n`;
    text += `Silakan lakukan pembayaran melalui QRIS di atas.\n`;
    text += `Batas waktu pembayaran: 5 menit.\n`;
    text += `Nominal sudah terintegrasi secara otomatis.`;
    return text;
}

function getInvoiceInlineKeyboard(trxId) {
    return Markup.inlineKeyboard([
        [Markup.button.callback('Batalkan Transaksi', `cancel_trx_${trxId}`)]
    ]);
}

function generateCanceledText(trx, reason = 'Transaksi telah dibatalkan atau melewati batas waktu pembayaran.') {
    let text = `TRANSAKSI DIBATALKAN\n`;
    text += `====================================\n\n`;
    text += `No. Invoice  : ${trx.trxId}\n`;
    text += `Layanan      : ${trx.productName} (x${trx.qty})\n`;
    text += `Total Tagihan: Rp${trx.totalPrice.toLocaleString('id-ID')}\n`;
    text += `Keterangan   : ${reason}\n\n`;
    text += `====================================\n`;
    text += `Transaksi telah dibatalkan dan stok telah dikembalikan secara otomatis.`;
    return text;
}

function getCanceledInlineKeyboard(trxId) {
    return Markup.inlineKeyboard([]);
}

function generateAdminSuccessText(trx) {
    return (
        `TRANSAKSI SUKSES\n` +
        `====================================\n\n` +
        `No. Invoice  : ${trx.trxId}\n` +
        `Pembeli      : ${trx.firstName} (@${trx.username || '-'})\n` +
        `ID Telegram  : ${trx.userId}\n` +
        `Layanan      : ${trx.productName} (x${trx.qty})\n` +
        `Total Bayar  : Rp${trx.totalPrice.toLocaleString('id-ID')}`
    );
}

function generateDeliveryText(trx) {
    const cfg = getConfig();
    const storeName = cfg.storeName || 'BR STORE';
    const items = Array.isArray(trx.lockedItems) ? trx.lockedItems : [];

    let text = `INFORMASI PESANAN SELESAI\n`;
    text += `====================================\n\n`;
    text += `No. Invoice  : ${trx.trxId}\n`;
    text += `Layanan      : ${trx.productName}\n`;
    text += `Jumlah       : ${trx.qty} pcs\n\n`;
    text += `DETAIL AKUN / LAYANAN:\n`;
    text += `------------------------------------\n`;

    if (items.length > 5) {
        text += `Detail akun lengkap terlampir pada dokumen .txt di bawah ini.\n`;
    } else {
        items.forEach((item, idx) => {
            text += `${idx + 1}. ${item}\n`;
        });
    }

    text += `------------------------------------\n`;
    text += `Terima kasih telah bertransaksi di ${storeName}.`;
    return text;
}

module.exports = {
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
};