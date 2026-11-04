const { GoogleGenAI } = require("@google/genai");

const responseSchema = {
  type: "OBJECT",
  properties: {
    location: { type: "STRING" },
    reservoir: { type: "STRING" },
    plant: { type: "STRING" },
    hardness_value: { type: "STRING" },
    hardness_level: { type: "STRING" },
    description: { type: "STRING" },
    advice: { type: "STRING" },
    filter: { type: "STRING" }
  },
  required: [
    "location", "reservoir", "plant", "hardness_value",
    "hardness_level", "description", "advice", "filter"
  ]
};

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...headers, Allow: "POST" },
      body: JSON.stringify({ error: "僅支援 POST 查詢。" })
    };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Netlify 尚未設定 GEMINI_API_KEY 環境變數。"
      })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "查詢資料格式錯誤。" })
    };
  }

  const location = String(body.location || "").trim();
  if (!location || location.length > 120) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: "請提供有效的縣市／行政區或地址（最多 120 字）。"
      })
    };
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const prompt = `你是台灣民生用水資訊助理。使用者查詢地點：${location}。
請以繁體中文回傳符合指定 JSON schema 的內容。
重要準則：
1. 不可捏造水庫、淨水場、硬度或 TDS 數值。
2. 若無法確認該地實際供水系統，reservoir 或 plant 請寫「需向台灣自來水公司／地方供水單位確認」，不要猜測。
3. 若沒有該地址最新且可信的硬度檢測數據，hardness_value 寫「無可核實的即時數據」，hardness_level 寫「資料不足，請以水質檢測為準」。
4. description 說明供水區可能因管網、調度與混水而不同。
5. advice 提供一般性居家用水建議，不要把水垢直接等同污染。
6. filter 僅提供依實際水質檢測與產品認證選擇濾材的中立建議，不得宣稱能治療或保證安全。
7. 不得假稱已查詢政府即時資料或實驗室數據。`;

    const result = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema,
        temperature: 0.2,
        maxOutputTokens: 900
      }
    });

    const raw = result.text || "";
    const data = JSON.parse(raw);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ...data, location: data.location || location })
    };
  } catch (error) {
    console.error("Gemini water query error:", error);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: "Gemini 水質分析服務暫時無法使用。",
        detail: error && error.message ? error.message : "未知錯誤"
      })
    };
  }
};
