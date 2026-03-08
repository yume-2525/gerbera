(function() {
  'use strict';

  const API_BASE = 'https://gerbera-backend-jb9g.onrender.com/api/items';

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
   * 現在の割引価格を計算する関数（main.py のロジックをJSで簡易再現）
   */
  function calculateCurrentPrice(originalPrice, minPrice, expiryTimeIso) {
    const remainingMinutes = getRemainingMinutes(expiryTimeIso);
    if (remainingMinutes == null) return originalPrice;
    
    const t_hours = remainingMinutes / 60;
    const T_hours = 6.0;

    if (t_hours <= 0) return 0; // 期限切れ
    if (t_hours >= T_hours) return originalPrice; // まだ定価

    // バックエンドでは在庫数(alpha)を考慮していますが、
    // ここでは一覧表示用のおおよその現在価格として、alpha=1 (直線的な割引) で計算します。
    // より正確な価格を出すには、バックエンド側で現在価格を計算して返すエンドポイントを作るのが理想です。
    let currentPrice = minPrice + (originalPrice - minPrice) * (t_hours / T_hours);
    return Math.floor(currentPrice / 10) * 10;
  }

  /**
   * APIから全件取得 → 商品名で集約し、さらに賞味期限ごとにグループ化
   */
  function fetchAndProcessItems() {
    return fetch(API_BASE)
      .then(function(res) { return res.ok ? res.json() : []; })
      .then(function(rows) {
        const byName = {};
        
        // 1. まずは「商品名」でグループ化
        rows.forEach(function(row) {
          const remainingMinutes = getRemainingMinutes(row.expiry_time);
          if (remainingMinutes == null || remainingMinutes < 0) return; 
          if (row.status && row.status !== 'on_sale') return;
          
          const name = row.name || '（名前なし）';
          if (!byName[name]) {
            byName[name] = {
              name: name,
              original_price: row.original_price,
              min_price: row.min_price,
              totalStock: 0,
              batches: {} // 賞味期限ごとのグループ
            };
          }
          
          byName[name].totalStock += 1; // 1行 = 1個なので +1

          // 2. さらに同じ商品の中で「賞味期限」ごとにグループ化
          const exp = row.expiry_time;
          if (!byName[name].batches[exp]) {
            byName[name].batches[exp] = {
              expiry_time: exp,
              count: 0,
              remainingMinutes: getRemainingMinutes(exp)
            };
          }
          byName[name].batches[exp].count += 1;
        });

        // 3. 表示しやすいように配列に変換し、ソートする
        return Object.values(byName).map(function(p) {
          // batchesを配列にして、残り時間が少ない順（期限が近い順）にソート
          const sortedBatches = Object.values(p.batches).sort((a, b) => {
             const ra = a.remainingMinutes == null ? 999999 : a.remainingMinutes;
             const rb = b.remainingMinutes == null ? 999999 : b.remainingMinutes;
             return ra - rb;
          });

          // グループ全体での最短の残り時間を取得（親カードの表示用）
          const earliestBatch = sortedBatches[0];

          return {
            name: p.name,
            totalStock: p.totalStock,
            original_price: p.original_price,
            min_price: p.min_price,
            earliestRemainingMinutes: earliestBatch ? earliestBatch.remainingMinutes : null,
            batches: sortedBatches
          };
        }).sort(function(a, b) {
          // 商品一覧全体も、一番期限が近いものが含まれている順にソート
          const ra = a.earliestRemainingMinutes == null ? 999999 : a.earliestRemainingMinutes;
          const rb = b.earliestRemainingMinutes == null ? 999999 : b.earliestRemainingMinutes;
          return ra - rb;
        });
      });
  }

  // HTMLエスケープ処理
  function escapeHtml(s) {
    if (!s) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  // 時間をフォーマットする（例: 03/08 14:30）
  function formatTime(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    const mo = (date.getMonth() + 1).toString().padStart(2, '0'); // 月
    const d = date.getDate().toString().padStart(2, '0');         // 日
    const h = date.getHours().toString().padStart(2, '0');
    const m = date.getMinutes().toString().padStart(2, '0');
    return mo + '/' + d + ' ' + h + ':' + m;
  }

  // --- ここから追加 ---
  // 合計の「分」を「○日 ○時間 ○分」のテキストに変換する
  function formatRemainingTime(totalMinutes) {
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const minutes = totalMinutes % 60;

    let timeText = "";
    if (days > 0) {
      timeText += days + "日 ";
    }
    if (hours > 0 || days > 0) { // 日数がある場合は、0時間でも表示する
      timeText += hours + "時間 ";
    }
    timeText += minutes + "分";

    return "残り " + timeText;
  }
  // --- ここまで追加 ---


  function render(products) {
    const grid = document.getElementById('product-grid');
    const totalEl = document.getElementById('total-count');
    if (!grid) return;

    // 全体の在庫数を計算して表示
    const grandTotalStock = products.reduce(function(acc, p) { return acc + p.totalStock; }, 0);
    if (totalEl) totalEl.textContent = grandTotalStock;

    grid.innerHTML = '';

    // 取得した商品グループごとにHTMLを生成
    products.forEach(function(p, index) {
      const isUrgent = p.earliestRemainingMinutes != null && p.earliestRemainingMinutes < 60;

      // 1. 親カード（商品ごとのサマリー）を作成
      const card = document.createElement('div');
      card.className = 'bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col cursor-pointer hover:border-amber-400 transition-colors';
      
      // アコーディオンの開閉を制御するためのID
      const detailsId = 'details-' + index;

      // 2. 詳細部分（賞味期限ごとのリスト）のHTMLを組み立てる
      let detailsHtml = '<div class="bg-slate-50 p-3 space-y-2 border-t border-slate-100">';
      p.batches.forEach(batch => {
          const currentPrice = calculateCurrentPrice(p.original_price, p.min_price, batch.expiry_time);
          const discountAmount = p.original_price - currentPrice;
          
          let statusText = batch.remainingMinutes < 0 ? '<span class="text-red-500 font-bold">期限切れ</span>' : formatRemainingTime(batch.remainingMinutes);

          detailsHtml += `
            <div class="flex justify-between items-center bg-white p-2 rounded border border-slate-200 text-sm">
                <div>
                    <div class="font-medium text-slate-700">期限: ${formatTime(batch.expiry_time)}</div>
                    <div class="text-xs text-slate-500">${statusText}</div>
                </div>
                <div class="text-right">
                    <div class="font-bold text-amber-600">${currentPrice}円 <span class="text-xs text-slate-400 line-through">${p.original_price}円</span></div>
                    <div class="text-xs text-emerald-600 font-medium">(${discountAmount}円 おトク!)</div>
                </div>
                <div class="bg-slate-100 text-slate-700 px-3 py-1 rounded-full text-xs font-bold">
                    残り ${batch.count}個
                </div>
            </div>
          `;
      });
      detailsHtml += '</div>';

      // 3. カード全体のHTMLをセット
      card.innerHTML = `
        <div class="p-4 flex-1 flex justify-between items-center" onclick="document.getElementById('${detailsId}').classList.toggle('hidden')">
            <div>
                ${isUrgent ? '<span class="text-xl" aria-hidden="true">⏳</span> ' : ''}
                <h2 class="font-bold text-slate-800 text-lg inline-block">${escapeHtml(p.name)}</h2>
                <div class="text-sm text-slate-500 mt-1">定価: ${p.original_price}円</div>
            </div>
            <div class="text-right">
                <div class="text-xs text-slate-500">総在庫</div>
                <div class="text-2xl font-bold text-slate-700">${p.totalStock}<span class="text-sm font-normal"> 個</span></div>
                <div class="text-xs text-amber-600 mt-1">▼ タップして詳細を見る</div>
            </div>
        </div>
        <div id="${detailsId}" class="hidden">
            ${detailsHtml}
        </div>
      `;
      
      grid.appendChild(card);
    });
  }

  function run() {
    fetchAndProcessItems()
      .then(render)
      .catch(function(err) {
        console.error(err);
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