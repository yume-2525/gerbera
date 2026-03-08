// ★ 1. 書き換え可能な商品データの定義（let を使用）
let PRESET_DATA = {
    bento: [
        { name: 'チキン南蛮弁当', original: 600, min: 300 },
        { name: '特製幕の内弁当', original: 750, min: 400 },
        { name: '三元豚のロースかつ重', original: 680, min: 350 },
        { name: '鮭の塩焼き弁当', original: 550, min: 280 }
    ],
    salad: [
        { name: '1/2日分の野菜サラダ', original: 450, min: 220 },
        { name: 'ポテトサラダ（大）', original: 300, min: 150 },
        { name: '蒸し鶏のチョレギサラダ', original: 480, min: 240 }
    ],
    onigiri: [
        { name: '手作りおにぎり（ツナマヨ）', original: 160, min: 80 },
        { name: '手作りおにぎり（鮭）', original: 180, min: 90 },
        { name: '手作りおにぎり（昆布）', original: 150, min: 70 }
    ]
};

// ★ 2. 子メニュー（商品リスト）を表示する関数
function showSubMenu(category) {
    const submenu = document.getElementById('preset-submenu');
    const itemsContainer = document.getElementById('submenu-items');
    const title = document.getElementById('submenu-title');
    
    if (!submenu || !itemsContainer) return;

    itemsContainer.innerHTML = '';
    title.textContent = `Select ${category}`;
    
    PRESET_DATA[category].forEach(item => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bg-white border border-slate-200 px-3 py-1.5 rounded-md text-[11px] font-bold text-slate-600 hover:border-blue-400 hover:text-blue-600 transition-all shadow-sm';
        btn.textContent = item.name;
        // プリセット適用時に、その時点での最新価格（item.original, item.min）を渡す
        btn.onclick = () => applyPreset(item.name, item.original, item.min);
        itemsContainer.appendChild(btn);
    });
    
    submenu.classList.remove('hidden');
}

// プリセットを適用する関数
function applyPreset(name, originalPrice, minPrice) {
    document.getElementById('name').value = name;
    document.getElementById('original_price').value = originalPrice;
    document.getElementById('min_price').value = minPrice;
    
    // 3時間後の期限設定
    const now = new Date();
    const jstNow = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    jstNow.setHours(jstNow.getHours() + 3); 
    const expiryString = jstNow.toISOString().slice(0, 16);
    document.getElementById('expiry_time').value = expiryString;

    // 視覚的なフィードバック（左側のフォームを光らせる）
    const formContainer = document.querySelector('.lg\\:w-1\\/3');
    if (formContainer) {
        formContainer.classList.add('ring-4', 'ring-blue-500/20');
        setTimeout(() => formContainer.classList.remove('ring-4', 'ring-blue-500/20'), 600);
    }
}
// ページ読み込み時に実行
setDefaultExpiry();

// --- 1. 商品登録処理（現在のレイアウト専用） ---
async function registerItem(event) {
    if (event) event.preventDefault();

    const submitBtn = document.getElementById('registerBtn');
    // qrcodeContainerは隠し要素としてHTMLに存在する必要があります
    const container = document.getElementById('qrcodeContainer');

    if (!submitBtn) return; // エラー防止

    const itemData = {
        name: document.getElementById('name').value,
        original_price: parseInt(document.getElementById('original_price').value),
        min_price: parseInt(document.getElementById('min_price').value),
        stock: parseInt(document.getElementById('stock').value),
        // ISO形式に変換
        expiry_time: document.getElementById('expiry_time').value + ":00+09:00"
    };

    // 簡易バリデーション
    if (!itemData.name || isNaN(itemData.original_price) || isNaN(itemData.stock)) {
        alert("入力内容に不備があります。");
        return;
    }

    // 処理開始
    submitBtn.disabled = true;
    submitBtn.innerText = "登録＆PDF作成中...";
    container.innerHTML = ""; 

    try {
        const response = await fetch('https://gerbera-backend-jb9g.onrender.com/api/items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(itemData)
        });

        if (!response.ok) throw new Error("サーバーエラーが発生しました。");
        const data = await response.json();
        
        // PDF用のラベルを隠しエリアに生成
        data.ids.forEach((id, index) => {
            const card = createLabelElementForPDF(id, itemData, index);
            container.appendChild(card);
            
            // QRコードの描画
            new QRCode(document.getElementById(`qr-pdf-${index}`), {
                text: id,
                width: 64,
                height: 64,
                colorDark : "#000000",
                colorLight : "#ffffff",
                correctLevel : QRCode.CorrectLevel.L
            });
        });

        // QRコードの描画時間を待つ（500msから1.5秒に増やして安定させます）
        // 描画待ち時間を1.5秒（1500ms）に設定
        setTimeout(async () => {
            try {
                await downloadPDF(); 
                container.innerHTML = ""; 
                loadInventory(); 
                alert("登録完了！PDFをダウンロードしました。");
            } catch (pdfErr) {
                console.error("PDF生成失敗:", pdfErr);
                alert("PDFの作成に失敗しました。もう一度試してください。");
            } finally {
                submitBtn.disabled = false;
                submitBtn.innerText = "登録してQRコードを発行";
            }
        }, 1500); // ここを1500に！

    } catch (e) {
        console.error("登録エラー:", e);
        alert("登録に失敗しました。URLやネットワークを確認してください。");
        submitBtn.disabled = false;
        submitBtn.innerText = "登録してQRコードを発行";
    }
}

// --- 2. PDF用ラベル作成補助関数 ---
function createLabelElementForPDF(id, itemData, index) {
    const card = document.createElement('div');
    // PDF生成時にhtml2canvasが認識できるようにクラスを付与
    card.className = "qr-label bg-white p-2 border-2 border-gray-300 w-[400px] flex flex-col mb-4";
    
    const d = new Date(itemData.expiry_time);
    const formattedExpiry = `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${d.getHours()}時${d.getMinutes()}分`;

    card.innerHTML = `
        <div class="bg-yellow-400 text-black font-extrabold text-center text-lg py-1 mb-2">QRコードを読み取って現在の価格をチェック</div>
        <div class="flex justify-between items-center px-2">
            <div id="qr-pdf-${index}"></div>
            <div class="ml-3 text-right w-full">
                <div class="text-xl font-bold text-gray-900">${itemData.name}</div>
                <div class="text-3xl font-black text-gray-900">${itemData.original_price}円</div>
            </div>
        </div>
        <div class="border-t border-gray-400 pt-1 mt-2 text-[10px] flex justify-between">
            <span>消費期限: ${formattedExpiry}</span>
            <span>ID: ${id.slice(-8)}</span>
        </div>
    `;
    return card;
}

// ====== PDF生成関数の調整 ======
// ====== PDF生成関数の調整（エラー箇所を修正） ======
async function downloadPDF() {
    // ボタンの存在チェックを入れて、エラーを防ぐ
    const pdfBtn = document.querySelector('button[onclick="downloadPDF()"]');
    let originalText = "";
    if (pdfBtn) {
        originalText = pdfBtn.innerText;
        pdfBtn.innerText = "PDF作成中...";
        pdfBtn.disabled = true;
    }

    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        
        const labels = document.querySelectorAll('.qr-label');
        // 入力フォームから商品名を取得
        const itemName = document.getElementById('name').value || "label";

        if (labels.length === 0) {
            console.warn("保存するラベルがありません。");
            return;
        }

        let x = 10;
        let y = 10;
        const labelWidth = 90;  
        const labelHeight = 45; 

        for (let i = 0; i < labels.length; i++) {
            // 背景を白に強制し、確実に描画させる設定
            const canvas = await html2canvas(labels[i], { 
                scale: 1.5, 
                useCORS: true, 
                backgroundColor: "#ffffff", // 背景を白にする
                logging: false 
            });
            
            const imgData = canvas.toDataURL('image/jpeg', 0.9);

            // 画像が空（真っ白）でないかチェック（デバッグ用）
            if (imgData === "data:,") {
                console.error("ラベルの画像化に失敗しました:", i);
                continue;
            }

            doc.addImage(imgData, 'JPEG', x, y, labelWidth, labelHeight);

            // 以降の座標計算ロジックはそのまま
            x += labelWidth + 10;
            if (x + labelWidth > 200) { 
                x = 10;
                y += labelHeight + 10;
            }
            if (y + labelHeight > 280 && i < labels.length - 1) {
                doc.addPage();
                y = 10;
                x = 10;
            }
        }

        doc.save(`${itemName}_labels.pdf`);
    } catch (error) {
        console.error("PDF生成エラー:", error);
        throw error; // 上の階層（registerItem）にエラーを伝えてアラートを出す
    } finally {
        if (pdfBtn) {
            pdfBtn.innerText = originalText;
            pdfBtn.disabled = false;
        }
    }
}

// ページが読み込まれたら実行
document.addEventListener('DOMContentLoaded', async () => {
    try {
        // ① さっきバックエンドで作ったAPIからデータを取得
        // ※URLの http://127.0.0.1:8000 はバックエンドの環境に合わせて調整してください
        const response = await fetch('http://127.0.0.1:8000/api/item-templates');
        const templates = await response.json();
        
        const dataList = document.getElementById('item-name-list');
        const nameInput = document.getElementById('name');
        const originalPriceInput = document.getElementById('original_price');
        const minPriceInput = document.getElementById('min_price');

        // ② 取得した商品データを使って、プルダウンの選択肢を作る
        templates.forEach(template => {
            const option = document.createElement('option');
            option.value = template.name;
            dataList.appendChild(option);
        });

        // ③ 入力欄が変わったときのイベントを設定
        nameInput.addEventListener('input', (event) => {
            const selectedName = event.target.value;
            
            // 入力された名前と一致するデータが過去にあるか探す
            const matchedTemplate = templates.find(t => t.name === selectedName);
            
            // 見つかったら、定価と底値を自動で書き換える
            if (matchedTemplate) {
                originalPriceInput.value = matchedTemplate.original_price;
                minPriceInput.value = matchedTemplate.min_price;
            }
        });

    } catch (error) {
        console.error('商品テンプレートの取得に失敗しました:', error);
    }
});

// ==========================================
// ▼ ここから追加：在庫一覧と強制売り切れ機能 ▼
// ==========================================

// 在庫データを取得してカテゴリ別に表示する関数
async function loadInventory() {
    const container = document.getElementById('inventoryContainer');
    if (!container) return;
    container.innerHTML = '<p class="text-gray-500 col-span-full font-bold">読み込み中...</p>';

    try {
        const response = await fetch('https://gerbera-backend-jb9g.onrender.com/api/items');
        if (!response.ok) throw new Error('在庫の取得に失敗しました');
        const items = await response.json();

        // --- カテゴリ判定ロジック ---
        const categorize = (name) => {
            for (const [cat, productList] of Object.entries(PRESET_DATA)) {
                if (productList.some(p => p.name === name)) return cat;
            }
            return 'others'; // プリセットにない場合は「その他」
        };

        const categoryNames = { bento: '🍱 お弁当', salad: '🥗 サラダ', onigiri: '🍙 おにぎり', others: '📦 その他' };
        
        // データをカテゴリ > 商品名+期限 でネストしてグループ化
        const grouped = { bento: {}, salad: {}, onigiri: {}, others: {} };

        items.forEach(item => {
            const cat = categorize(item.name);
            const key = item.name + '_' + item.expiry_time;
            
            if (!grouped[cat][key]) {
                grouped[cat][key] = {
                    name: item.name,
                    expiry_time: item.expiry_time,
                    ids: []
                };
            }
            grouped[cat][key].ids.push(item.id);
        });

        // HTML生成
        container.innerHTML = '';
        let hasAnyItem = false;

        for (const [catKey, itemsInCat] of Object.entries(grouped)) {
            const groupValues = Object.values(itemsInCat);
            if (groupValues.length === 0) continue; // 空のカテゴリは表示しない
            hasAnyItem = true;

            // カテゴリの見出しを作成
            const section = document.createElement('div');
            section.className = 'col-span-full mt-4 mb-2';
            section.innerHTML = `<h3 class="text-sm font-black text-slate-500 bg-slate-100 px-3 py-1 rounded-full w-fit">${categoryNames[catKey]}</h3>`;
            container.appendChild(section);

            // カテゴリ内の商品カードを作成
            groupValues.forEach(g => {
                const d = new Date(g.expiry_time);
                const formattedTime = `${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
                
                const card = document.createElement('div');
                card.className = 'bg-white border-2 border-slate-200 p-4 rounded-xl flex justify-between items-center shadow-sm hover:border-blue-200 transition-colors';
                
                const targetId = g.ids[0];

                card.innerHTML = `
                    <div>
                        <div class="font-extrabold text-slate-800 text-base">${g.name}</div>
                        <div class="text-[11px] text-slate-400 mt-1 font-bold">期限: ${formattedTime}</div>
                    </div>
                    <div class="text-right flex flex-col items-end gap-1">
                        <div class="text-2xl font-black text-slate-700 leading-none">${g.ids.length}<span class="text-xs font-bold text-slate-400 ml-1">個</span></div>
                        <button onclick="forceSoldOut('${targetId}')" class="text-red-400 hover:text-red-600 text-[10px] font-bold mt-1 underline decoration-dotted">
                            1個減らす
                        </button>
                    </div>
                `;
                container.appendChild(card);
            });
        }

        if (!hasAnyItem) {
            container.innerHTML = '<p class="text-gray-500 col-span-full font-bold text-lg text-center py-8">現在、販売中の商品はありません。</p>';
        }

    } catch (error) {
        console.error(error);
        container.innerHTML = '<p class="text-red-500 font-bold col-span-full">在庫の読み込みに失敗しました。</p>';
    }
}
// 強制的に売り切れ（1個減らす）にする処理
async function forceSoldOut(itemId) {
    if (!confirm('この商品を1個「売り切れ」にしますか？\n（アプリを通さずに店頭で売れた場合など）')) {
        return;
    }

    try {
        const response = await fetch(`https://gerbera-backend-jb9g.onrender.com/api/items/${itemId}/purchase`, {
            method: 'POST'
        });

        if (!response.ok) throw new Error('更新に失敗しました');

        // 成功したら在庫一覧を再読み込みする
        loadInventory();

    } catch (error) {
        console.error(error);
        alert('処理に失敗しました。');
    }
}


