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

mock_db = {
    "BENTO_001": {
        "id": "BENTO_001",
        "name": "特製幕の内弁当",
        "original_price": 800,
        "min_price": 400, # 原価・限界価格
        # デモ用に、消費期限を「現在時刻の2時間後」に設定
        "expiry_time": now + timedelta(hours=2) 
    },
    "BENTO_002": {
        "id": "BENTO_002",
        "name": "鮭の塩焼き弁当",
        "original_price": 600,
        "min_price": 300,
        # デモ用に、消費期限を「現在時刻の30分後」に設定（かなり安くなる）
        "expiry_time": now + timedelta(minutes=30)
    }
}

# --- 価格計算アルゴリズム ---
def calculate_dynamic_price(item_data: dict, current_time: datetime) -> dict:
    original_price = item_data["original_price"]
    min_price = item_data["min_price"]
    expiry_time = item_data["expiry_time"]
    
    # 残り時間を計算（時間単位）
    time_diff = expiry_time - current_time
    t_hours = time_diff.total_seconds() / 3600.0

    T_hours = 6.0 # 割引を開始する時間（期限の6時間前から）

    if t_hours <= 0:
        current_price = 0
        status = "expired"
    elif t_hours >= T_hours:
        current_price = original_price
        status = "normal"
    else:
        # 二次関数的な割引計算
        current_price = min_price + (original_price - min_price) * ((t_hours / T_hours) ** 2)
        current_price = math.floor(current_price / 10) * 10 # 10円単位で切り捨て
        status = "discounted"

    # 割引率の計算
    discount_rate = 0
    if original_price > 0 and current_price > 0 and status != "expired":
        discount_rate = int((1 - (current_price / original_price)) * 100)

    return {
        "id": item_data["id"],
        "name": item_data["name"],
        "original_price": original_price,
        "current_price": int(current_price),
        "discount_rate": discount_rate,
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