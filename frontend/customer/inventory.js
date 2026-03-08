(function() {
  'use strict';

  const API_BASE = 'https://gerbera-backend-jb9g.onrender.com/api/items';
  let allProducts = []; 
  let currentCategory = 'all';

  function getRemainingMinutes(expiryTimeIso) {
    if (!expiryTimeIso || typeof expiryTimeIso !== 'string') return null;
    const expiryMs = new Date(expiryTimeIso).getTime();
    if (isNaN(expiryMs)) return null;
    return Math.floor((expiryMs - Date.now()) / (60 * 1000));
  }

  function calculateCurrentPrice(originalPrice, minPrice, expiryTimeIso) {
    const remainingMinutes = getRemainingMinutes(expiryTimeIso);
    if (remainingMinutes == null) return originalPrice;
    
    const t_hours = remainingMinutes / 60;
    const T_hours = 6.0;

    if (t_hours <= 0) return 0;
    if (t_hours >= T_hours) return originalPrice;

    let currentPrice = minPrice + (originalPrice - minPrice) * (t_hours / T_hours);
    return Math.floor(currentPrice / 10) * 10;
  }

  // ★変更：商品名からカテゴリを自動判定する関数（お肉とお魚を追加）
  function determineCategory(name) {
    if (name.includes('弁当') || name.includes('幕の内') || name.includes('かつ重')) return 'bento';
    if (name.includes('サラダ')) return 'salad';
    if (name.includes('おにぎり')) return 'onigiri';
    // 新しく追加した判定ルール
    if (name.includes('肉') || name.includes('牛') || name.includes('豚') || name.includes('鶏')) return 'meat';
    if (name.includes('魚') || name.includes('鮭') || name.includes('刺身') || name.includes('鯖')) return 'fish';
    return 'other';
  }

  // ★変更：カテゴリから大体のフードロス削減量（グラム）を算出する関数
  function getFoodLossGrams(category) {
    if (category === 'bento') return 400;
    if (category === 'salad') return 150;
    if (category === 'onigiri') return 100;
    // 新しく追加した削減量（お肉300g、お魚250gの想定）
    if (category === 'meat') return 300;
    if (category === 'fish') return 250;
    return 200; // その他
  }

  function fetchAndProcessItems() {
    return fetch(API_BASE)
      .then(function(res) { return res.ok ? res.json() : []; })
      .then(function(rows) {
        const byName = {};
        
        rows.forEach(function(row) {
          const remainingMinutes = getRemainingMinutes(row.expiry_time);
          if (remainingMinutes == null || remainingMinutes < 0) return; 
          if (row.status && row.status !== 'on_sale') return;
          
          const name = row.name || '（名前なし）';
          if (!byName[name]) {
            byName[name] = {
              name: name,
              category: determineCategory(name),
              original_price: row.original_price,
              min_price: row.min_price,
              totalStock: 0,
              batches: {}
            };
          }
          
          byName[name].totalStock += 1;

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

        return Object.values(byName).map(function(p) {
          const sortedBatches = Object.values(p.batches).sort((a, b) => {
             const ra = a.remainingMinutes == null ? 999999 : a.remainingMinutes;
             const rb = b.remainingMinutes == null ? 999999 : b.remainingMinutes;
             return ra - rb;
          });

          const earliestBatch = sortedBatches[0];
          const currentPrice = earliestBatch ? calculateCurrentPrice(p.original_price, p.min_price, earliestBatch.expiry_time) : p.original_price;
          const discountAmount = p.original_price - currentPrice;
          const discountRate = p.original_price > 0 ? (discountAmount / p.original_price) : 0;

          return {
            name: p.name,
            category: p.category,
            totalStock: p.totalStock,
            original_price: p.original_price,
            min_price: p.min_price,
            earliestRemainingMinutes: earliestBatch ? earliestBatch.remainingMinutes : null,
            currentPrice: currentPrice,
            discountAmount: discountAmount,
            discountRate: discountRate,
            batches: sortedBatches
          };
        });
      });
  }

  function sortProducts(products, sortType) {
    return products.slice().sort((a, b) => {
      const ra = a.earliestRemainingMinutes == null ? 999999 : a.earliestRemainingMinutes;
      const rb = b.earliestRemainingMinutes == null ? 999999 : b.earliestRemainingMinutes;

      if (sortType === 'expiry_asc') return ra - rb;
      if (sortType === 'price_asc') return a.currentPrice - b.currentPrice;
      if (sortType === 'discount_desc') return b.discountAmount - a.discountAmount;
      
      const urgencyA = Math.max(0, 100 - (ra / 6));
      const urgencyB = Math.max(0, 100 - (rb / 6));
      const scoreA = (a.discountRate * 100) * 1.5 + urgencyA;
      const scoreB = (b.discountRate * 100) * 1.5 + urgencyB;
      return scoreB - scoreA;
    });
  }

  function updateDisplay() {
    let filtered = allProducts;
    if (currentCategory !== 'all') {
      filtered = allProducts.filter(p => p.category === currentCategory);
    }
    const sortSelect = document.getElementById('sort-select');
    const sortType = sortSelect ? sortSelect.value : 'recommend';
    const sorted = sortProducts(filtered, sortType);
    render(sorted);
  }

  function escapeHtml(s) {
    if (!s) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function formatTime(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    const mo = (date.getMonth() + 1).toString().padStart(2, '0');
    const d = date.getDate().toString().padStart(2, '0');
    const h = date.getHours().toString().padStart(2, '0');
    const m = date.getMinutes().toString().padStart(2, '0');
    return mo + '/' + d + ' ' + h + ':' + m;
  }

  function formatRemainingTime(totalMinutes) {
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const minutes = totalMinutes % 60;
    let timeText = "";
    if (days > 0) timeText += days + "日 ";
    if (hours > 0 || days > 0) timeText += hours + "時間 ";
    timeText += minutes + "分";
    return "残り " + timeText;
  }

  function render(products) {
    const grid = document.getElementById('product-grid');
    const totalEl = document.getElementById('total-count');
    if (!grid) return;

    const grandTotalStock = products.reduce(function(acc, p) { return acc + p.totalStock; }, 0);
    if (totalEl) totalEl.textContent = grandTotalStock;

    grid.innerHTML = '';

    if (products.length === 0) {
      grid.innerHTML = '<p class="text-slate-500 col-span-full py-8 text-center">このカテゴリの商品は現在ありません。</p>';
      return;
    }

    products.forEach(function(p, index) {
      const isUrgent = p.earliestRemainingMinutes != null && p.earliestRemainingMinutes < 60;
      
      const card = document.createElement('div');
      const detailsId = 'details-' + index;
      
      // ★追加：この商品のフードロス削減量を計算
      const foodLossGrams = getFoodLossGrams(p.category);

      if (isUrgent) {
        card.className = 'bg-red-50 rounded-xl shadow-md border-2 border-red-400 overflow-hidden flex flex-col cursor-pointer hover:bg-red-100 transition-colors relative';
      } else {
        card.className = 'bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col cursor-pointer hover:border-amber-400 transition-colors relative';
      }

      let detailsHtml = '<div class="bg-slate-50 p-3 space-y-2 border-t border-slate-100">';
      p.batches.forEach(batch => {
          const currentPrice = calculateCurrentPrice(p.original_price, p.min_price, batch.expiry_time);
          const discountAmount = p.original_price - currentPrice;
          
          let statusText = '';
          if (batch.remainingMinutes < 0) {
            statusText = '<span class="text-red-500 font-bold">期限切れ</span>';
          } else if (batch.remainingMinutes < 60) {
            statusText = `<span class="text-red-600 font-bold flex items-center gap-1"><span class="animate-pulse">⚠️</span>${formatRemainingTime(batch.remainingMinutes)}</span>`;
          } else {
            statusText = formatRemainingTime(batch.remainingMinutes);
          }

          // ★変更：価格表示の下に「🌍 約〇〇gロス削減」を追加
          detailsHtml += `
            <div class="flex justify-between items-center bg-white p-2 rounded border border-slate-200 text-sm gap-2">
                <div class="whitespace-nowrap">
                    <div class="font-medium text-slate-700">期限: ${formatTime(batch.expiry_time)}</div>
                    <div class="text-xs text-slate-500">${statusText}</div>
                </div>
                <div class="text-right whitespace-nowrap">
                    <div class="font-bold text-amber-600">${currentPrice}円 <span class="text-xs text-slate-400 line-through">${p.original_price}円</span></div>
                    <div class="text-xs text-emerald-600 font-medium">(${discountAmount}円 おトク!)</div>
                    <div class="text-[10px] text-blue-500 font-bold mt-0.5 tracking-wide">🌍 約${foodLossGrams}gロス削減</div>
                </div>
                <div class="bg-slate-100 text-slate-700 px-2 py-1 rounded-full text-xs font-bold whitespace-nowrap flex-shrink-0">
                    残り ${batch.count}個
                </div>
            </div>
          `;
      });
      detailsHtml += '</div>';

      card.innerHTML = `
        ${isUrgent ? '<div class="absolute top-0 right-0 bg-red-500 text-white text-xs font-bold px-3 py-1 rounded-bl-xl shadow-sm animate-pulse">急いでレスキュー！</div>' : ''}
        <div class="p-4 flex-1 flex justify-between items-center" onclick="document.getElementById('${detailsId}').classList.toggle('hidden')">
            <div>
                <h2 class="font-bold text-slate-800 text-lg inline-block">${escapeHtml(p.name)}</h2>
                <div class="text-sm text-slate-500 mt-1">定価: ${p.original_price}円</div>
            </div>
            <div class="text-right">
                <div class="text-xs text-slate-500">総在庫</div>
                <div class="text-2xl font-bold ${isUrgent ? 'text-red-600' : 'text-slate-700'}">${p.totalStock}<span class="text-sm font-normal"> 個</span></div>
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
      .then(function(products) {
        allProducts = products; 
        
        const sortSelect = document.getElementById('sort-select');
        if (sortSelect) {
          sortSelect.addEventListener('change', updateDisplay);
        }

        const filterBtns = document.querySelectorAll('.filter-btn');
        filterBtns.forEach(btn => {
          btn.addEventListener('click', (e) => {
            filterBtns.forEach(b => {
              b.classList.remove('bg-amber-500', 'text-white', 'shadow-sm');
              b.classList.add('bg-white', 'text-slate-600', 'border-slate-200');
            });
            
            const target = e.currentTarget;
            target.classList.remove('bg-white', 'text-slate-600', 'border-slate-200');
            target.classList.add('bg-amber-500', 'text-white', 'shadow-sm');

            currentCategory = target.dataset.category;
            updateDisplay();
          });
        });
        
        updateDisplay();
      })
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