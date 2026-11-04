
const { GoogleGenAI } = require("@google/genai");

// 台灣自來水公司官方水質資料
const OFFICIAL_CSV_URL =
  "https://www.water.gov.tw/opendata/qual5.csv";

// Gemini 回傳資料格式
const responseSchema = {
  type: "OBJECT",
  properties: {
    location: { type: "STRING" },
    reservoir: { type: "STRING" },
    plant: { type: "STRING" },
    hardness_value: { type: "STRING" },
    hardness_level: { type: "STRING" },
    tds_value: { type: "STRING" },
    description: { type: "STRING" },
    advice: { type: "STRING" },
    filter: { type: "STRING" }
  },
  required: [
    "location",
    "reservoir",
    "plant",
    "hardness_value",
    "hardness_level",
    "tds_value",
    "description",
    "advice",
    "filter"
  ]
};

// 暫時性錯誤自動重試
const sleep = (ms) =>
  new Promise(resolve => setTimeout(resolve, ms));

function isTemporaryGeminiError(error) {
  const status = Number(
    error &&
    (
      error.status ||
      error.code ||
      (error.error && error.error.code)
    )
  );

  const message = String(
    error && error.message || ""
  ).toLowerCase();

  return [429, 500, 502, 503, 504].includes(status) ||
    message.includes("high demand") ||
    message.includes("temporarily unavailable") ||
    message.includes("unavailable");
}

async function generateWithRetry(ai, request, maxRetries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ai.models.generateContent(request);
    } catch (error) {
      if (
        attempt >= maxRetries ||
        !isTemporaryGeminiError(error)
      ) {
        throw error;
      }

      const delayMs = 800 * (2 ** attempt);

      console.warn(
        `Gemini 暫時性錯誤，${delayMs}ms 後重試。`
      );

      await sleep(delayMs);
    }
  }
}

// CSV 解析，支援逗號、引號及換行
function parseCSV(text) {
  const firstLine = text.split(/\r?\n/)[0] || "";

  const delimiters = [",", "\t", ";"];

  const delimiter = delimiters.reduce(
    (best, current) =>
      firstLine.split(current).length >
      firstLine.split(best).length
        ? current
        : best,
    ","
  );

  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      row.push(field.trim());
      field = "";
    } else if (
      (char === "\n" || char === "\r") &&
      !quoted
    ) {
      if (char === "\r" && text[i + 1] === "\n") {
        i++;
      }

      row.push(field.trim());

      if (row.some(value => value !== "")) {
        rows.push(row);
      }

      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  row.push(field.trim());

  if (row.some(value => value !== "")) {
    rows.push(row);
  }

  return rows;
}

// 取得官方總硬度資料
async function getOfficialHardness(location) {
  try {
    const response = await fetch(OFFICIAL_CSV_URL, {
      headers: {
        "Accept": "text/csv"
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      throw new Error(
        `官方 CSV 讀取失敗：HTTP ${response.status}`
      );
    }

    const csv = (await response.text())
      .replace(/^\uFEFF/, "");

    const rows = parseCSV(csv);

    if (rows.length < 2) {
      throw new Error("官方 CSV 沒有有效資料");
    }

    const headers = rows[0].map(value =>
      value.replace(/^"|"$/g, "").trim()
    );

    const itemIndex = headers.indexOf("檢驗項目");
    const cityIndex = headers.indexOf("縣市別");
    const districtIndex = headers.indexOf("鄉鎮市區別");
    const valueIndex = headers.indexOf("檢驗數值");
    const unitIndex = headers.indexOf("單位");

    if (
      [
        itemIndex,
        cityIndex,
        districtIndex,
        valueIndex,
        unitIndex
      ].some(index => index === -1)
    ) {
      throw new Error("官方 CSV 欄位格式不符合預期");
    }

    // 從地址擷取縣市及行政區
    const cityMatch = location.match(
      /[\u4e00-\u9fff]{2,3}[縣市]/
    );

    const districtMatch = location.match(
      /[\u4e00-\u9fff]{1,3}(?:區|鄉|鎮|市)/
    );

    if (!cityMatch || !districtMatch) {
      return {
        value: "請輸入完整縣市及行政區",
        source: "台灣自來水公司官方水質資料",
        found: false
      };
    }

    const city = cityMatch[0];
    const district = districtMatch[0];

    const matchedRows = rows.slice(1).filter(row =>
      row[itemIndex] === "總硬度" &&
      row[cityIndex] === city &&
      row[districtIndex] === district &&
      row[valueIndex] !== ""
    );

    if (matchedRows.length === 0) {
      return {
        value: "目前查無官方總硬度資料",
        source: "台灣自來水公司官方水質資料",
        found: false
      };
    }

    // 去除重複數值
    const uniqueResults = [
      ...new Map(
        matchedRows.map(row => [
          `${row[valueIndex]}|${row[unitIndex]}`,
          {
            value: row[valueIndex],
            unit: row[unitIndex]
          }
        ])
      ).values()
    ];

    return {
      value: uniqueResults
        .map(item => `${item.value} ${item.unit}`)
        .join("、"),
      source: "台灣自來水公司官方水質資料",
      found: true
    };

  } catch (error) {
    console.error("官方水質資料讀取錯誤：", error);

    return {
      value: "官方水質資料暫時無法取得",
      source: "台灣自來水公司官方水質資料",
      found: false
    };
  }
}

// 主查詢功能
exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: {
        ...headers,
        Allow: "POST"
      },
      body: JSON.stringify({
        error: "僅支援 POST 查詢。"
      })
    };
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Netlify 尚未設定 GEMINI_API_KEY。"
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
      body: JSON.stringify({
        error: "查詢資料格式錯誤。"
      })
    };
  }

  const location = String(
    body.location || ""
  ).trim();

  if (!location || location.length > 120) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: "請輸入有效地址，最多 120 字。"
      })
    };
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    const prompt = `
你是台灣民生用水資訊助理。

使用者查詢地點：${location}

請以繁體中文回傳指定 JSON 格式。

重要規則：
1. 不可捏造水庫、淨水場、硬度或 TDS 數值。
2. hardness_value 暫時填寫「待取得官方檢驗資料」。
3. hardness_level 填寫「以官方檢驗數值判斷」。
4. tds_value 填寫「目前沒有可用的官方 TDS 資料」。
5. 無法確認水庫或淨水場時，請明確標示需向供水單位確認。
6. 不得把 TDS 當成硬度。
7. 不得假稱已查詢政府即時資料。
8. 說明不同地區可能因供水管網調度而有差異。
9. 提供一般居家用水建議。
10. 濾水器建議必須中立，不得保證安全或療效。
`;

    const result = await generateWithRetry(ai, {
      model: "gemini-3.5-flash-lite",
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

    // 官方硬度資料優先於 AI 回答
   console.log("地址查詢：", location);
   console.log("官方硬度查詢結果：", officialHardness);

    data.hardness_value = officialHardness.value;

    data.hardness_level = officialHardness.found
      ? "官方檢驗數值，僅代表資料所列的檢驗結果"
      : "目前沒有可用的官方檢驗數值";

    // TDS 不使用硬度數值代替
    data.tds_value =
      "目前沒有可用的官方 TDS 資料";

    data.description +=
      ` 總硬度資料來源：${officialHardness.source}。` +
      "TDS 與總硬度是不同的水質指標，不可互相替代。";

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ...data,
        location: data.location || location,
        hardness_source: officialHardness.source,
        hardness_found: officialHardness.found
      })
    };

  } catch (error) {
    console.error("Gemini water query error:", error);

    const temporary =
      isTemporaryGeminiError(error);

    return {
      statusCode: temporary ? 503 : 502,
      headers,
      body: JSON.stringify({
        error: temporary
          ? "目前 Gemini 服務忙碌，請稍後再試。"
          : "水質分析服務發生錯誤，請稍後再試。"
      })
    };
  }
};
