from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime, timedelta, timezone
import math

app = FastAPI(title="Dynamic Pricing API")

# フロントエンドからのアクセスを許可するCORS設定（ハッカソン必須！）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # 本番環境ではフロントエンドのドメインを指定
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- 擬似データベース（マスターデータ） ---
# 実際はMySQLやSQLite等に入れますが、今回は辞書でモックアップを作ります
JST = timezone(timedelta(hours=+9), 'JST')
now = datetime.now(JST)

# --- 擬似データベースの修正（stockを追加） ---
mock_db = {
    # パターン1: 割引中（在庫多め → 早く安くなる）
    "BENTO_001": {
        "id": "BENTO_001",
        "name": "特製幕の内弁当",
        "original_price": 800,
        "min_price": 400,
        "stock": 10, 
        "expiry_time": now + timedelta(hours=2) 
    },
    # パターン2: 割引中（在庫残りわずか → 高値キープ）
    "BENTO_002": {
        "id": "BENTO_002",
        "name": "鮭の塩焼き弁当",
        "original_price": 600,
        "min_price": 300,
        "stock": 2, 
        "expiry_time": now + timedelta(hours=2) 
    },
    # パターン3: 定価（時間がたっぷりある）
    "BENTO_003": {
        "id": "BENTO_003",
        "name": "三元豚のロースかつ重",
        "original_price": 700,
        "min_price": 350,
        "stock": 5,
        "expiry_time": now + timedelta(hours=10)
    },
    # パターン4: 激安（期限ギリギリ ＆ 在庫過多）
    "BENTO_004": {
        "id": "BENTO_004",
        "name": "1/2日分の野菜サラダ",
        "original_price": 300,
        "min_price": 150,
        "stock": 15,
        "expiry_time": now + timedelta(minutes=15)
    },
    # パターン5: 売り切れ（stockが0）
    "BENTO_005": {
        "id": "BENTO_005",
        "name": "手作りおにぎり（ツナマヨ）",
        "original_price": 150,
        "min_price": 50,
        "stock": 0,
        "expiry_time": now + timedelta(hours=5)
    },
    # パターン6: 期限切れ（過去の時間）
    "BENTO_006": {
        "id": "BENTO_006",
        "name": "具だくさん豚汁",
        "original_price": 250,
        "min_price": 100,
        "stock": 8,
        # timedeltaをマイナスにして「30分前に期限切れ」を再現
        "expiry_time": now - timedelta(minutes=30) 
    }
}

# --- 価格計算アルゴリズムの修正（在庫数の組み込み） ---
def calculate_dynamic_price(item_data: dict, current_time: datetime) -> dict:
    original_price = item_data["original_price"]
    min_price = item_data["min_price"]
    expiry_time = item_data["expiry_time"]
    stock = item_data.get("stock", 0)
    
    # 売り切れ時の処理
    if stock <= 0:
        return {
            "id": item_data["id"], "name": item_data["name"],
            "original_price": original_price, "current_price": 0,
            "discount_rate": 0, "stock": 0, "status": "sold_out",
            "expiry_time": expiry_time.isoformat()
        }

    time_diff = expiry_time - current_time
    t_hours = time_diff.total_seconds() / 3600.0
    T_hours = 6.0

    if t_hours <= 0:
        current_price = 0
        status = "expired"
    elif t_hours >= T_hours:
        current_price = original_price
        status = "normal"
    else:
        # 在庫に基づく指数アルファの計算（基準在庫を5とする）
        alpha = stock / 5.0
        # 極端な値崩れを防ぐため、アルファの範囲を 0.5(急落) 〜 3.0(維持) に制限
        alpha = max(0.5, min(3.0, alpha))
        
        # 在庫連動型の割引計算
        current_price = min_price + (original_price - min_price) * ((t_hours / T_hours) ** alpha)
        current_price = math.floor(current_price / 10) * 10
        status = "discounted"

    discount_rate = 0
    if original_price > 0 and current_price > 0 and status != "expired":
        discount_rate = int((1 - (current_price / original_price)) * 100)

    return {
        "id": item_data["id"],
        "name": item_data["name"],
        "original_price": original_price,
        "current_price": int(current_price),
        "discount_rate": discount_rate,
        "stock": stock,          # フロントエンドに在庫数を渡す
        "status": status,
        "expiry_time": expiry_time.isoformat()
    }
# --- APIエンドポイント ---
@app.get("/api/items/{item_id}")
def get_item(item_id: str):
    if item_id not in mock_db:
        return {"error": "Item not found"}
    
    item_data = mock_db[item_id]
    current_time = datetime.now(JST)
    
    # 計算結果をJSON形式で返す
    return calculate_dynamic_price(item_data, current_time)