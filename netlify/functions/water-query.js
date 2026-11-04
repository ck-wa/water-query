
const { GoogleGenAI } = require("@google/genai");

const OFFICIAL_CSV_URL =
  "https://www.water.gov.tw/opendata/qual5.csv";

const MODEL_NAME = "gemini-3.5-flash-lite";

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

// 暫時性錯誤重試
const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function isTemporaryGeminiError(error) {
  const status = Number(
    error?.status ||
    error?.code ||
    error?.error?.code
  );

  const message = String(error?.message || "")
    .toLowerCase();

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

      const delay = 800 * (2 ** attempt);

      console.warn(
        `Gemini 暫時錯誤，${delay}ms 後重試`
      );

      await sleep(delay);
    }
  }
}

// CSV 解析
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

// 官方硬度查詢
async function getOfficialHardness(location) {
  try {
    console.log("開始讀取官方 CSV");

    const response = await fetch(OFFICIAL_CSV_URL, {
      headers: {
        Accept: "text/csv"
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      throw new Error(
        `CSV HTTP 狀態：${response.status}`
      );
    }

    const csv = (await response.text())
      .replace(/^\uFEFF/, "");

    const rows = parseCSV(csv);

    if (rows.length < 2) {
      throw new Error("CSV 沒有有效資料");
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
      ].some(index => index < 0)
    ) {
      throw new Error(
        "CSV 欄位名稱與預期不同：" +
        headers.join(",")
      );
    }

    // 先取得縣市，再從縣市後方擷取行政區
    const cityMatch = location.match(
      /[\u4e00-\u9fff]{2,3}[縣市]/
    );

    const city = cityMatch ? cityMatch[0] : "";

    const afterCity = cityMatch
      ? location.slice(
          location.indexOf(city) + city.length
        )
      : location;

    const districtMatch = afterCity.match(
      /[\u4e00-\u9fff]{1,3}(?:區|鄉|鎮|市)/
    );

    const district = districtMatch
      ? districtMatch[0]
      : "";

    if (!cityMatch || !districtMatch) {
      return {
        value: "請輸入完整縣市及行政區",
        source: "台灣自來水公司官方資料",
        found: false
      };
    }

    console.log(
      "官方資料比對地區：",
      city,
      district
    );

    const matchedRows = rows.slice(1).filter(row =>
      row[itemIndex] === "總硬度" &&
      row[cityIndex] === city &&
      row[districtIndex] === district &&
      row[valueIndex] !== ""
    );

    if (matchedRows.length === 0) {
      console.log(
        "官方 CSV 找不到該行政區硬度資料"
      );

      return {
        value: "目前查無官方總硬度資料",
        source: "台灣自來水公司官方資料",
        found: false
      };
    }

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

    const result = uniqueResults
      .map(item => `${item.value} ${item.unit}`)
      .join("、");

    console.log(
      "官方硬度查詢成功：",
      result
    );

    return {
      value: result,
      source: "台灣自來水公司官方資料",
      found: true
    };

  } catch (error) {
    console.error(
      "官方 CSV 查詢錯誤：",
      error.message
    );

    return {
      value: "官方水質資料暫時無法取得",
      source: "台灣自來水公司官方資料",
      found: false
    };
  }
}

// Gemini 說明文字
async function getAIExplanation(location, hardness) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.warn(
      "未設定 GEMINI_API_KEY，使用基本說明"
    );

    return null;
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    const prompt = `
你是台灣民生用水資訊助理。

使用者查詢地址：${location}

已取得的官方總硬度資料：
${hardness}

請使用繁體中文提供：
1. 水庫名稱：無法確認就寫待確認。
2. 淨水場名稱：無法確認就寫待確認。
3. 硬度等級說明：不可自行捏造數值。
4. 居家用水建議。
5. 濾水器選購建議。

重要規則：
- 不可猜測水庫或淨水場。
- 不可編造水質檢驗數字。
- TDS 與總硬度是不同指標。
- 不可把總硬度當成 TDS。
- 不得假稱已查詢政府即時資料。
- 不得宣稱水垢等於污染。
- 使用繁體中文。
`;

    const result = await generateWithRetry(ai, {
      model: MODEL_NAME,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema,
        temperature: 0.2,
        maxOutputTokens: 900
      }
    });

    return JSON.parse(result.text || "{}");

  } catch (error) {
    console.error(
      "Gemini 查詢錯誤：",
      error.message
    );

    return null;
  }
}

// Netlify 主程式
exports.handler = async event => {
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
    console.log(
      "開始查詢地址：",
      location
    );

    // 先查官方資料，不依賴 Gemini
    const officialHardness =
      await getOfficialHardness(location);

    console.log(
      "官方硬度結果：",
      officialHardness
    );

    // Gemini 只負責補充說明
    const aiData = await getAIExplanation(
      location,
      officialHardness.value
    );

    const data = {
      location,

      reservoir:
        aiData?.reservoir ||
        "尚待官方供水資料確認",

      plant:
        aiData?.plant ||
        "尚待官方供水資料確認",

      hardness_value:
        officialHardness.value,

      hardness_level:
        officialHardness.found
          ? "官方檢驗數值，請依檢驗資料判讀"
          : "目前沒有可用的官方檢驗數值",

      tds_value:
        "目前沒有可用的官方 TDS 資料",

      description:
        aiData?.description ||
        "本次查詢依官方公開資料比對。實際供水情形可能因管網及調度而異。",

      advice:
        aiData?.advice ||
        "如需確認飲用水品質，可參考所在地供水單位公布的水質檢驗資料。",

      filter:
        aiData?.filter ||
        "建議先確認實際水質檢測結果，再依濾材認證及用途選擇產品。",

      hardness_source:
        officialHardness.source,

      hardness_found:
        officialHardness.found
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(data)
    };

  } catch (error) {
    console.error(
      "Water query error:",
      error
    );

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "後端查詢發生錯誤。",
        diagnostic: String(
          error?.message || error
        ).slice(0, 300)
      })
    };
  }
};
