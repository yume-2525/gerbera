import sqlite3
import uuid
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from datetime import datetime, timedelta, timezone
import math

import google.generativeai as genai
import os

# TODO: ここに取得したGemini APIキーを入れます（ハッカソン中は直書きが一番早いです！）
genai.configure(api_key="あなたの_API_KEY_をここに入力")

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
    
    # main.py の init_db() 内
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS items (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            original_price INTEGER NOT NULL,
            min_price INTEGER NOT NULL,
            expiry_time TEXT NOT NULL,
            status TEXT DEFAULT 'on_sale'
        )
    """)
    
    # 開発用: もしテーブルが空なら、テスト用データをINSERTしておく
    # 開発用: もしテーブルが空なら、テスト用データをINSERTしておく
    cursor.execute("SELECT COUNT(*) FROM items")
    if cursor.fetchone()[0] == 0:
        now = datetime.now(JST)
        # サンプルデータから「在庫数」の数字を削除しました
        sample_data = [
            ("BENTO_001", "特製幕の内弁当", 800, 400, (now + timedelta(hours=2)).isoformat()),
            ("BENTO_002", "鮭の塩焼き弁当", 600, 300, (now + timedelta(hours=2)).isoformat()),
            ("BENTO_003", "三元豚のロースかつ重", 700, 350, (now + timedelta(hours=10)).isoformat()),
            ("BENTO_004", "1/2日分の野菜サラダ", 300, 150, (now + timedelta(minutes=15)).isoformat()),
            ("BENTO_005", "手作りおにぎり（ツナマヨ）", 150, 50, (now + timedelta(hours=5)).isoformat()),
            ("BENTO_006", "具だくさん豚汁", 250, 100, (now - timedelta(minutes=30)).isoformat())
        ]
        # INSERT文から stock を消して、? の数も 6個 から 5個 に減らしました
        cursor.executemany(
            "INSERT INTO items (id, name, original_price, min_price, expiry_time) VALUES (?, ?, ?, ?, ?)",
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
            "discount_rate": 0, "stock": 0, "status": item_data.get("status", "purchased"), # ⭕️ DBの実際のステータスを返すか、purchasedにする
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
        status = "on_sale"      # ⭕️ 定価だけど販売中
    else:
        # 在庫に基づく指数アルファの計算（基準在庫を5とする）
        alpha = stock / 5.0
        # 極端な値崩れを防ぐため、アルファの範囲を 0.5(急落) 〜 3.0(維持) に制限
        alpha = max(0.5, min(3.0, alpha))
        
        # 在庫連動型の割引計算
        current_price = min_price + (original_price - min_price) * ((t_hours / T_hours) ** alpha)
        current_price = math.floor(current_price / 10) * 10
        status = "on_sale"      # ⭕️ 値引き中だけど販売中

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
@app.get("/api/items")
def get_all_items():
    """商品一覧（カタログ・在庫一覧ページ用）。販売中の全件を賞味期限の昇順で返す。"""
    conn = sqlite3.connect("gerbera.db")
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # ★追加：データ取得の直前に、現在時刻を過ぎている商品の status を 'expired' に更新
    current_time_str = datetime.now(JST).isoformat()
    cursor.execute(
        "UPDATE items SET status = 'expired' WHERE status = 'on_sale' AND expiry_time <= ?",
        (current_time_str,)
    )
    conn.commit()

    # ★変更：status が 'on_sale' のものだけを取得する (WHERE status = 'on_sale' を追加)
    cursor.execute("SELECT * FROM items WHERE status = 'on_sale' ORDER BY expiry_time ASC")
    rows = cursor.fetchall()
    conn.close()
    
    return [
        {
            "id": row["id"],
            "name": row["name"],
            "original_price": row["original_price"],
            "min_price": row["min_price"],
            "expiry_time": row["expiry_time"],
            "status": row["status"] # フロントエンドでの判定用にステータスも送る
        }
        for row in rows
    ]

@app.get("/api/items/{item_id}")
def get_item(item_id: str):
    conn = sqlite3.connect("gerbera.db")
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    current_time = datetime.now(JST)
    current_time_str = current_time.isoformat()

    # ★追加：データを取り出す「直前」に、現在時刻を過ぎている商品の status を一斉に 'expired' に変更！
    cursor.execute(
        "UPDATE items SET status = 'expired' WHERE status = 'on_sale' AND expiry_time <= ?",
        (current_time_str,)
    )
    conn.commit() # 変更を保存

    # ② SQLを発行して該当するIDのデータを検索
    cursor.execute("SELECT * FROM items WHERE id = ?", (item_id,))
    row = cursor.fetchone()

    if not row:
        conn.close()
        return {"error": "Item not found"}
    
    # ③ データベースの行データをPythonの辞書に変換
    item_data = dict(row)
    
    # 【追加チェック】もし自分が検索した商品が今まさに期限切れになっていたら、売り切れと同じ扱いにする
    if item_data["status"] == "expired":
        conn.close()
        return {
            "id": item_data["id"], "name": item_data["name"],
            "original_price": item_data["original_price"], "current_price": 0,
            "discount_rate": 0, "stock": 0, "status": "expired",
            "expiry_time": item_data["expiry_time"]
        }

    item_name = item_data["name"]

    # 販売中の在庫だけをカウント（期限切れは上で expired になったのでカウントされない）
    cursor.execute("SELECT COUNT(*) as current_stock FROM items WHERE name = ? AND status = 'on_sale'", (item_name,))
    stock_count = cursor.fetchone()["current_stock"]
    
    conn.close()

    item_data["stock"] = stock_count
    # SQLiteには日時が文字列(TEXT)で保存されているので、計算用にdatetime型に戻す
    item_data["expiry_time"] = datetime.fromisoformat(item_data["expiry_time"])
    
    # ④ 計算関数に渡して返す
    return calculate_dynamic_price(item_data, current_time)


@app.post("/api/items")
def create_item(item: ItemCreate):
    conn = sqlite3.connect("gerbera.db")
    cursor = conn.cursor()
    
    generated_ids = []

    # 在庫数（item.stock）の分だけループして個別のIDを発行・保存する
    for i in range(item.stock):
        new_id = f"ITEM_{str(uuid.uuid4())[:8].upper()}"
        
        # ここから stock を削除しました（? も 6個 から 5個 に）
        cursor.execute(
            """
            INSERT INTO items (id, name, original_price, min_price, expiry_time)
            VALUES (?, ?, ?, ?, ?)
            """,
            (new_id, item.name, item.original_price, item.min_price, item.expiry_time)
        )
        generated_ids.append(new_id)

    conn.commit()
    conn.close()

    return {
        "message": f"{item.stock}個の商品を登録しました！",
        "ids": generated_ids,
        "details": {
            "name": item.name,
            "count": item.stock
        }
    }

@app.post("/api/items/{item_id}/purchase")
def purchase_item(item_id: str):
    conn = sqlite3.connect("gerbera.db")
    cursor = conn.cursor()

    # status を 'purchased' に更新する
    cursor.execute(
        "UPDATE items SET status = 'purchased' WHERE id = ? AND status = 'on_sale'",
        (item_id,)
    )
    
    # 更新された行がなければ、すでに売れているか存在しない
    if cursor.rowcount == 0:
        conn.close()
        return JSONResponse(status_code=400, content={"message": "すでに購入済みか、販売されていません"})

    conn.commit()
    conn.close()

    return {"message": "success", "status": "purchased"}


@app.get("/api/item-templates")
def get_item_templates():
    conn = sqlite3.connect("gerbera.db")
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # GROUP BY を使って、同じ名前の商品の最新の定価・底値を取得する
    cursor.execute("""
        SELECT name, original_price, min_price 
        FROM items 
        GROUP BY name
    """)
    rows = cursor.fetchall()
    conn.close()
    
    # 辞書のリストとして返す
    return [dict(row) for row in rows]

