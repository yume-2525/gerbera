// 1. 初期値の設定（日本時間の現在時刻から3時間後をセット）
function setDefaultExpiry() {
    const now = new Date();
    // タイムゾーンのオフセット（日本は+9時間）を考慮してローカル時間を計算
    const jstNow = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    jstNow.setHours(jstNow.getHours() + 3); 
    
    // datetime-localが受け取れる "YYYY-MM-DDTHH:mm" 形式にカット
    const defaultTime = jstNow.toISOString().slice(0, 16);
    document.getElementById('expiry_time').value = defaultTime;
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

// 在庫データを取得して表示する関数
async function loadInventory() {
    const container = document.getElementById('inventoryContainer');
    if (!container) return;
    container.innerHTML = '<p class="text-gray-500 col-span-full font-bold">読み込み中...</p>';

    try {
        const response = await fetch('https://gerbera-backend-jb9g.onrender.com/api/items');
        if (!response.ok) throw new Error('在庫の取得に失敗しました');
        const items = await response.json();

        // 商品名と賞味期限でグループ化する（カタログ画面と同じ要領）
        const grouped = {};
        items.forEach(item => {
            const key = item.name + '_' + item.expiry_time;
            if (!grouped[key]) {
                grouped[key] = {
                    name: item.name,
                    expiry_time: item.expiry_time,
                    original_price: item.original_price,
                    ids: [] // このグループに属するIDのリストを保持
                };
            }
            grouped[key].ids.push(item.id);
        });

        const groups = Object.values(grouped);

        if (groups.length === 0) {
            container.innerHTML = '<p class="text-gray-500 col-span-full font-bold text-lg text-center py-8">現在、販売中の商品はありません。</p>';
            return;
        }

        container.innerHTML = '';
        groups.forEach(g => {
            // 時間のフォーマット (例: 3/8 14:30)
            const d = new Date(g.expiry_time);
            const formattedTime = `${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;

            const card = document.createElement('div');
            card.className = 'bg-slate-50 border-2 border-slate-200 p-4 rounded-xl flex justify-between items-center shadow-sm hover:border-slate-300 transition-colors';

            // 削除用に使うID（リストの最初の1つを取り出す）
            const targetId = g.ids[0];

            card.innerHTML = `
                <div>
                    <div class="font-extrabold text-slate-800 text-lg">${g.name}</div>
                    <div class="text-sm text-slate-500 mt-1 font-medium">期限: ${formattedTime}</div>
                </div>
                <div class="text-right flex flex-col items-end gap-2">
                    <div class="text-3xl font-black text-slate-700 leading-none">${g.ids.length}<span class="text-sm font-bold text-slate-500 ml-1">個</span></div>
                    <button onclick="forceSoldOut('${targetId}')" class="bg-red-50 text-red-600 border-2 border-red-200 px-3 py-1.5 rounded-lg text-sm font-bold hover:bg-red-100 hover:border-red-300 transition-colors flex items-center gap-1 shadow-sm mt-1">
                        🗑️ 1個減らす
                    </button>
                </div>
            `;
            container.appendChild(card);
        });

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

