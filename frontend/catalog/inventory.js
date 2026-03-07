(function() {
  'use strict';

  const API_BASE = 'http://localhost:8000/api/items';

  /**
   * 賞味期限までの残り分数を計算
   */
  function getRemainingMinutes(expiryTimeIso) {
    if (!expiryTimeIso || typeof expiryTimeIso !== 'string') return null;
    const expiryMs = new Date(expiryTimeIso).getTime();
    if (isNaN(expiryMs)) return null;
    return Math.floor((expiryMs - Date.now()) / (60 * 1000));
  }

  /**
   * 期限が近いほど高得点になる「ありがとうポイント」
   * 残り60分以内で最大100pt、残り時間が長いほど減点
   */
  function calcThankYouPoints(remainingMinutes) {
    if (remainingMinutes == null || remainingMinutes < 0) return 0;
    if (remainingMinutes <= 60) return Math.max(0, Math.round(100 - remainingMinutes * 0.5));
    if (remainingMinutes <= 360) return Math.max(0, Math.round(50 - (remainingMinutes - 60) / 6));
    return Math.max(0, Math.round(10 - remainingMinutes / 60));
  }

  /**
   * APIから全件取得 → 商品名で集約し、残り時間昇順でソート
   */
  function fetchAndProcessItems() {
    return fetch(API_BASE)
      .then(function(res) { return res.ok ? res.json() : []; })
      .then(function(rows) {
        const byName = {};
        rows.forEach(function(row) {
          const name = row.name || '（名前なし）';
          if (!byName[name]) {
            byName[name] = {
              name: name,
              stock: 0,
              earliestExpiry: null,
              original_price: row.original_price,
              min_price: row.min_price,
              ids: []
            };
          }
          byName[name].stock += row.stock || 1;
          byName[name].ids.push(row.id);
          const exp = row.expiry_time;
          if (exp) {
            const t = new Date(exp).getTime();
            if (!byName[name].earliestExpiry || t < byName[name].earliestExpiry) {
              byName[name].earliestExpiry = t;
              byName[name].expiry_time = exp;
            }
          }
        });
        const products = Object.values(byName).map(function(p) {
          const remaining = getRemainingMinutes(p.expiry_time);
          return {
            name: p.name,
            stock: p.stock,
            expiry_time: p.expiry_time,
            remainingMinutes: remaining,
            original_price: p.original_price,
            min_price: p.min_price,
            thankYouPoints: calcThankYouPoints(remaining)
          };
        });
        products.sort(function(a, b) {
          const ra = a.remainingMinutes == null ? 999999 : a.remainingMinutes;
          const rb = b.remainingMinutes == null ? 999999 : b.remainingMinutes;
          return ra - rb;
        });
        return products;
      });
  }

  /**
   * 在庫の最大値（プログレスバー用）。商品ごとのstockの最大で10程度を想定
   */
  function getStockMax(products) {
    const m = Math.max.apply(null, products.map(function(p) { return p.stock; }));
    return Math.max(10, m);
  }

  function render(products) {
    const grid = document.getElementById('product-grid');
    const totalEl = document.getElementById('total-count');
    if (!grid) return;

    const totalStock = products.reduce(function(acc, p) { return acc + p.stock; }, 0);
    if (totalEl) totalEl.textContent = totalStock;

    grid.innerHTML = '';
    const stockMax = getStockMax(products);

    products.forEach(function(p) {
      const remaining = p.remainingMinutes;
      const isUrgent = remaining != null && remaining < 60;
      const stockPct = stockMax > 0 ? Math.min(100, (p.stock / stockMax) * 100) : 0;

      const card = document.createElement('div');
      card.className = 'bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col';
      card.innerHTML =
        '<div class="p-4 flex-1">' +
          (isUrgent ? '<span class="text-2xl" aria-hidden="true">😢</span> ' : '') +
          '<h2 class="font-bold text-slate-800 text-lg">' + escapeHtml(p.name) + '</h2>' +
          '<p class="text-sm text-slate-500 mt-1">残り時間: ' + (remaining != null ? (remaining < 0 ? '期限切れ' : remaining + '分') : '—') + '</p>' +
          '<p class="text-sm text-amber-600 font-medium mt-1">ありがとうポイント: ' + p.thankYouPoints + ' pt</p>' +
          '<div class="mt-2">' +
            '<div class="flex justify-between text-xs text-slate-500 mb-0.5">' +
              '<span>在庫</span><span>' + p.stock + ' 個</span>' +
            '</div>' +
            '<div class="h-2 bg-slate-200 rounded-full overflow-hidden">' +
              '<div class="h-full bg-emerald-500 rounded-full transition-all" style="width:' + stockPct + '%"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="p-4 pt-0">' +
          '<a href="../customer/index.html" class="block w-full text-center py-2.5 px-4 rounded-lg font-medium bg-amber-500 text-white hover:bg-amber-600">お店に行って購入する</a>' +
        '</div>';
      grid.appendChild(card);
    });
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function run() {
    fetchAndProcessItems()
      .then(render)
      .catch(function() {
        var grid = document.getElementById('product-grid');
        if (grid) grid.innerHTML = '<p class="text-slate-500 col-span-full">読み込みに失敗しました。</p>';
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
