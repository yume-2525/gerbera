import sqlite3
import uuid
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from datetime import datetime, timedelta, timezone
import math


# フロントエンドからPOSTで送られてくるデータの形式
class ItemCreate(BaseModel):
    name: str
    original_price: int
    min_price: int
    stock: int
    expiry_time: str  # 例: "2026-03-08T15:00:00+09:00" のような文字列

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

# ==========================================
# 1. データベースの初期設定とサンプルデータ投入
# ==========================================
def init_db():
    conn = sqlite3.connect("gerbera.db")
    cursor = conn.cursor()
    
    # itemsテーブルを作成（ID, 名前, 定価, 底値, 在庫, 期限）
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS items (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            original_price INTEGER NOT NULL,
            min_price INTEGER NOT NULL,
            stock INTEGER NOT NULL,
            expiry_time TEXT NOT NULL
        )
    """)
    
    # 開発用: もしテーブルが空なら、テスト用データをINSERTしておく
    cursor.execute("SELECT COUNT(*) FROM items")
    if cursor.fetchone()[0] == 0:
        now = datetime.now(JST)
        sample_data = [
            ("BENTO_001", "特製幕の内弁当", 800, 400, 10, (now + timedelta(hours=2)).isoformat()),
            ("BENTO_002", "鮭の塩焼き弁当", 600, 300, 2, (now + timedelta(hours=2)).isoformat()),
            ("BENTO_003", "三元豚のロースかつ重", 700, 350, 5, (now + timedelta(hours=10)).isoformat()),
            ("BENTO_004", "1/2日分の野菜サラダ", 300, 150, 15, (now + timedelta(minutes=15)).isoformat()),
            ("BENTO_005", "手作りおにぎり（ツナマヨ）", 150, 50, 0, (now + timedelta(hours=5)).isoformat()),
            ("BENTO_006", "具だくさん豚汁", 250, 100, 8, (now - timedelta(minutes=30)).isoformat())
        ]
        cursor.executemany(
            "INSERT INTO items (id, name, original_price, min_price, stock, expiry_time) VALUES (?, ?, ?, ?, ?, ?)",
            sample_data
        )
        conn.commit()
    conn.close()

# サーバー起動時にデータベースを準備
init_db()



# app.include_router(recipe_router)

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

# ==========================================
# 3. APIエンドポイント（SQLiteから取得するように変更）
# ==========================================
@app.get("/api/items/{item_id}")
def get_item(item_id: str):
    # ① データベースに接続
    conn = sqlite3.connect("gerbera.db")
    conn.row_factory = sqlite3.Row # カラム名（nameやstockなど）でデータを取り出せるようにする設定
    cursor = conn.cursor()
    
    # ② SQLを発行して該当するIDのデータを検索
    cursor.execute("SELECT * FROM items WHERE id = ?", (item_id,))
    row = cursor.fetchone()
    conn.close()

    if not row:
        return {"error": "Item not found"}
    
    # ③ データベースの行データをPythonの辞書に変換
    item_data = dict(row)
    
    # SQLiteには日時が文字列(TEXT)で保存されているので、計算用にdatetime型に戻す
    item_data["expiry_time"] = datetime.fromisoformat(item_data["expiry_time"])
    
    current_time = datetime.now(JST)
    
    # ④ 計算関数に渡して返す
    return calculate_dynamic_price(item_data, current_time)

@app.post("/api/items")
def create_item(item: ItemCreate):
    conn = sqlite3.connect("gerbera.db")
    cursor = conn.cursor()
    
    generated_ids = []

    # 在庫数（item.stock）の分だけループしてIDを発行・保存する
    for i in range(item.stock):
        # 個別のユニークIDを生成
        new_id = f"ITEM_{str(uuid.uuid4())[:8].upper()}"
        
        cursor.execute(
            """
            INSERT INTO items (id, name, original_price, min_price, stock, expiry_time)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            # 個別のIDを保存。在庫管理をしやすくするため各レコードのstockは「1」として扱う
            (new_id, item.name, item.original_price, item.min_price, 1, item.expiry_time)
        )
        generated_ids.append(new_id)

    conn.commit()
    conn.close()

    # 発行された全てのIDリストをフロントに返す
    return {
        "message": f"{item.stock}個の商品を登録しました！",
        "ids": generated_ids,
        "details": {
            "name": item.name,
            "count": item.stock
        }
    }