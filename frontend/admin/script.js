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
    const submitBtn = document.querySelector('button');
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
            card.className = "bg-white p-3 border shadow-sm text-center rounded flex flex-col items-center";
            
            // IDを表示
            const idLabel = document.createElement('p');
            idLabel.className = "text-[10px] text-gray-400 mb-1";
            idLabel.innerText = id;
            card.appendChild(idLabel);

            // QRコードを描画するdiv
            const qrDiv = document.createElement('div');
            qrDiv.id = `qr-${index}`;
            card.appendChild(qrDiv);

            container.appendChild(card);

            // QRCodeライブラリを実行
            new QRCode(qrDiv, {
                text: id,
                width: 120,
                height: 120
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



async function downloadPDF() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    
    // 画面上のすべてのQRコード（Canvas）を取得
    const qrCanvases = document.querySelectorAll('#qrcodeContainer canvas');
    const itemName = document.getElementById('name').value;

    if (qrCanvases.length === 0) {
        alert("保存するQRコードがありません。");
        return;
    }

    doc.setFont("helvetica", "bold");
    doc.text(`Label List: ${itemName}`, 10, 10);

    let x = 10;
    let y = 20;
    const qrSize = 40; // PDF上でのQRコードのサイズ(mm)

    qrCanvases.forEach((canvas, index) => {
        // Canvasを画像データ(PNG)に変換
        const imgData = canvas.toDataURL('image/png');

        // PDFに画像を追加 (x, y, width, height)
        doc.addImage(imgData, 'PNG', x, y, qrSize, qrSize);
        doc.setFontSize(8);
        doc.text(`ID: ${canvas.parentElement.previousSibling.innerText}`, x, y + qrSize + 5);

        // レイアウト計算（横に3つ並んだら改行）
        x += qrSize + 20;
        if (x > 160) {
            x = 10;
            y += qrSize + 20;
        }

        // ページがいっぱいになったら新しいページを追加
        if (y > 250 && index < qrCanvases.length - 1) {
            doc.addPage();
            y = 20;
            x = 10;
        }
    });

    // ファイル名を「商品名_labels.pdf」にして保存
    doc.save(`${itemName}_labels.pdf`);
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