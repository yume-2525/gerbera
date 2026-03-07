# recipe_api.py の中身
import os
import json
import google.generativeai as genai
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from dotenv import load_dotenv

# 環境変数とGeminiの設定
load_dotenv()
API_KEY = os.getenv("GEMINI_API_KEY")
genai.configure(api_key=API_KEY)

# FastAPI() の代わりに APIRouter() を使う！
router = APIRouter()

class RecipeRequest(BaseModel):
    dish_name: str

@router.post("/api/recipe")
def generate_shopping_list(request: RecipeRequest):
    try:
        model = genai.GenerativeModel(
            'gemini-1.5-flash',
            generation_config={"response_mime_type": "application/json"}
        )
        
        prompt = f"""
        ユーザーはスーパーにいます。「{request.dish_name}」を作るために必要な一般的な材料を5〜8個リストアップしてください。
        以下のJSONスキーマに厳密に従って出力してください。
        {{
            "dish_name": "料理名",
            "ingredients": ["材料1", "材料2", "材料3"]
        }}
        """
        
        response = model.generate_content(prompt)
        result_data = json.loads(response.text)
        
        return JSONResponse(content=result_data, media_type="application/json; charset=utf-8")
        
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)