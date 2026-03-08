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

async function registerItem(event) {
    if (event) event.preventDefault(); // フォームのデフォルト送信を防止
    // ボタンの連打防止
    const submitBtn = document.getElementById('registerBtn');
    submitBtn.disabled = true;
    submitBtn.innerText = "登録中...";

    // 入力データの取得
    const itemData = {
        name: document.getElementById('name').value,
        original_price: parseInt(document.getElementById('original_price').value),
        min_price: parseInt(document.getElementById('min_price').value),
        stock: parseInt(document.getElementById('stock').value),
        // datetime-localの値をISO形式+JSTタイムゾーン(+09:00)に変換
        expiry_time: document.getElementById('expiry_time').value + ":00+09:00"
    };

    try {
        const response = await fetch('https://gerbera-backend-jb9g.onrender.com/api/items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(itemData)
        });

        if (!response.ok) throw new Error("サーバーエラー");

        const data = await response.json();
        
        // --- 表示処理 ---
        
        // 1. 結果エリア全体を見えるようにする
        const resultArea = document.getElementById('resultArea');
        resultArea.classList.remove('hidden');

        // 2. QRコードを入れるコンテナを空にする
        const container = document.getElementById('qrcodeContainer');
        container.innerHTML = ""; 

        // 3. 在庫数分（data.ids）のQRコードを生成して追加
        data.ids.forEach((id, index) => {
            const card = document.createElement('div');
            // ★変更：幅を大きく広げ(w-[400px])、横長のシールにする
            card.className = "bg-white p-2 border-2 border-gray-300 w-[400px] flex flex-col qr-label shadow-sm shrink-0 rounded-sm";
            card.style.fontFamily = "'Hiragino Kaku Gothic ProN', 'Meiryo', sans-serif";

            // ① 黄色いキャッチコピー帯
            const banner = document.createElement('div');
            banner.className = "bg-yellow-400 text-black font-extrabold text-center text-lg py-1 mb-2 border border-yellow-500 rounded-sm tracking-widest";
            banner.innerText = "QRで現在の価格をチェック";
            card.appendChild(banner);

            // ② 中段エリア（左：QR、右：商品名と定価）
            const middleRow = document.createElement('div');
            // 安定させるため px-1 に加えて py-1（上下余白）を足すのがおすすめです
            middleRow.className = "flex justify-between items-center px-1 py-1";

            const qrWrapper = document.createElement('div');
            qrWrapper.className = "flex-shrink-0";
            const qrDiv = document.createElement('div');
            qrDiv.id = `qr-${index}`;
            qrWrapper.appendChild(qrDiv);
            middleRow.appendChild(qrWrapper);

            const rightInfo = document.createElement('div');
            rightInfo.className = "ml-3 flex flex-col justify-center w-full text-right";
            rightInfo.innerHTML = `
                <div class="text-xl font-extrabold text-gray-900 whitespace-nowrap pb-1 mb-1">${itemData.name}</div>
                <div class="text-xs font-bold text-gray-600">定価(円)</div>
                <div class="text-4xl font-extrabold text-gray-900 pb-1">${itemData.original_price}</div>
            `;
            middleRow.appendChild(rightInfo);
            card.appendChild(middleRow);
            
            // ③ 下段エリア（保存方法と消費期限）
            const bottomRow = document.createElement('div');
            bottomRow.className = "flex justify-between items-end border-t border-gray-400 pt-1 mt-2 px-1";

            const d = new Date(itemData.expiry_time);
            const yy = String(d.getFullYear()).slice(-2);
            const mm = d.getMonth() + 1;
            const dd = d.getDate();
            const h = d.getHours();
            const ampm = h < 12 ? '午前' : '午後';
            const h12 = h % 12 || 12;
            const min = d.getMinutes() === 0 ? '00' : String(d.getMinutes()).padStart(2, '0');
            const formattedExpiry = `${yy}. ${mm}.${dd} ${ampm} ${h12}時${min}分`;

            bottomRow.innerHTML = `
                <div class="flex flex-col text-gray-800 text-left">
                    <p class="text-[9px] mb-1">直射日光・高温多湿を避け保存</p>
                    <div class="flex items-baseline gap-2">
                        <span class="text-xs font-bold">消費期限</span>
                        <span class="text-sm font-extrabold text-gray-900">${formattedExpiry}</span>
                    </div>
                </div>
                <div class="text-[9px] text-gray-400">ID: ${id.split('_')[1]}</div>
            `;
            card.appendChild(bottomRow);
            container.appendChild(card);

            // QRコードの生成（サイズを少し小さくしてバランスをとる）
            new QRCode(qrDiv, {
                text: id,
                width: 64,
                height: 64,
                colorDark : "#000000",
                colorLight : "#ffffff",
                correctLevel : QRCode.CorrectLevel.L
            });
        });

        // スムーズに結果画面までスクロール
        resultArea.scrollIntoView({ behavior: 'smooth' });

    } catch (e) {
        console.error("登録エラー:", e);
        alert("登録に失敗しました。サーバーが起動しているか確認してください。");
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerText = "登録してQRコードを発行";
    }
}


// ====== PDF生成関数の調整 ======
async function downloadPDF() {
    const pdfBtn = document.querySelector('button[onclick="downloadPDF()"]');
    const originalText = pdfBtn.innerText;
    pdfBtn.innerText = "PDF作成中...";
    pdfBtn.disabled = true;

    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        
        const labels = document.querySelectorAll('.qr-label');
        const itemName = document.getElementById('name').value;

        if (labels.length === 0) {
            alert("保存するラベルがありません。");
            return;
        }

        let x = 10;
        let y = 10;
        // ★変更：横長のシールに合わせてPDF上のサイズも横長に
        const labelWidth = 90;  
        const labelHeight = 45; 

        for (let i = 0; i < labels.length; i++) {
            const canvas = await html2canvas(labels[i], { scale: 2 });
            const imgData = canvas.toDataURL('image/png');

            doc.addImage(imgData, 'PNG', x, y, labelWidth, labelHeight);

            // ★変更：横幅が広くなったので、1段に並べられるのは2枚まで
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
        alert("PDFの作成に失敗しました。");
    } finally {
        pdfBtn.innerText = originalText;
        pdfBtn.disabled = false;
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