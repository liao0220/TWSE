exports.handler = async function(event) {
  try {
    const symbolsParam = event.queryStringParameters?.symbols || "";

    const symbols = [...new Set(
      symbolsParam
        .split(",")
        .map(normalizeSymbol)
        .filter(Boolean)
    )];

    if (symbols.length === 0) {
      return jsonResponse(400, {
        ok: false,
        message: "請提供股票代號，例如 ?symbols=2330,2317"
      });
    }

    const results = await fetchTwseMisQuotes(symbols);

    // ==========================================
    // 【優化】：盤中時間，如果證交所有缺 Z 值，用 Yahoo 批次補上
    // ==========================================
    if (isMarketOpen()) {
      // 1. 找出所有沒有即時成交價的股票
      const missingItems = Object.values(results).filter(item => !item.isRealtimePrice);

      if (missingItems.length > 0) {
        // 2. 一次性向 Yahoo 發送批次請求
        const yahooPrices = await fetchYahooQuotesBatch(missingItems);

        // 3. 將拿到的 Yahoo 價格更新回 results
        missingItems.forEach(item => {
          const yahooPrice = yahooPrices[item.symbol];
          if (yahooPrice) {
            item.price = yahooPrice;
            item.currentPrice = yahooPrice;
            item.z = yahooPrice; // 把 Yahoo 價格當作 z 值
            item.priceType = "yahoo";
            item.isRealtimePrice = true;
            item.source = "Yahoo Finance";
            
            // 重新計算漲跌幅
            if (item.yesterday > 0) {
              item.change = item.price - item.yesterday;
              item.changePercent = (item.change / item.yesterday) * 100;
            }
          }
        });
      }
    }
    // ==========================================

    return jsonResponse(200, {
      ok: true,
      source: "TWSE MIS",
      updatedAt: new Date().toISOString(),
      data: results
    });

  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      message: error.message || "即時報價取得失敗"
    });
  }
};


function normalizeSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(".TW", "")
    .replace(".TWO", "");
}

async function fetchTwseMisQuotes(symbols) {
  const homeUrl = `https://mis.twse.com.tw/stock/index.jsp?_=${Date.now()}`;

  const homeRes = await fetch(homeUrl, {
    headers: {
      "User-Agent": getUserAgent(),
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache"
    }
  });

  const setCookie = homeRes.headers.get("set-cookie") || "";
  const cookie = setCookie
    .split(",")
    .map(part => part.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");

  const results = {};
  const exChList = [];

  symbols.forEach(symbol => {
    exChList.push(`tse_${symbol}.tw`);
    exChList.push(`otc_${symbol}.tw`);
  });

  const apiUrl =
    `https://mis.twse.com.tw/stock/api/getStockInfo.jsp` +
    `?ex_ch=${exChList.join("|")}` +
    `&json=1` +
    `&delay=0` +
    `&odd=1` +
    `&_=${Date.now()}`;

  const apiRes = await fetch(apiUrl, {
    headers: {
      "User-Agent": getUserAgent(),
      "Referer": "https://mis.twse.com.tw/stock/index.jsp",
      "Accept": "application/json,text/plain,*/*",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      ...(cookie ? { "Cookie": cookie } : {})
    }
  });

  if (!apiRes.ok) {
    throw new Error(`TWSE MIS HTTP ${apiRes.status}`);
  }

  const json = await apiRes.json();
  const list = Array.isArray(json?.msgArray) ? json.msgArray : [];

  list.forEach(item => {
    const parsed = parseTwseMisItem(item);
    if (!parsed) return;

    const existing = results[parsed.symbol];
    if (!existing) {
      results[parsed.symbol] = parsed;
      return;
    }

    if (!existing.isRealtimePrice && parsed.isRealtimePrice) {
      results[parsed.symbol] = parsed;
    }
  });

  return results;
}

function parseTwseMisItem(item) {
  const symbol = normalizeSymbol(item.c);
  if (!symbol) return null;

  const z = parsePrice(item.z);
  const y = parsePrice(item.y);
  const open = parsePrice(item.o);
  const high = parsePrice(item.h);
  const low = parsePrice(item.l);
  const ask = parseFirstOrderPrice(item.a);
  const bid = parseFirstOrderPrice(item.b);

  let price = null;
  let priceType = "none";
  let isRealtimePrice = false;

  if (Number.isFinite(z) && z > 0) {
    price = z;
    priceType = "last";
    isRealtimePrice = true;
  } else if (Number.isFinite(y) && y > 0) {
    price = y;
    priceType = "yesterday";
    isRealtimePrice = false;
  }

  let change = null;
  let changePercent = null;

  if (Number.isFinite(price) && Number.isFinite(y) && y > 0) {
    change = price - y;
    changePercent = change / y * 100;
  }

  const rawDate = String(item.d || "").trim();
  const normalizedDate = normalizeTwseDate(rawDate);

  return {
    symbol,
    name: item.n || "",
    market: String(item.ex || "").includes("otc") ? "otc" : "tse",
    price,
    currentPrice: price,
    z,
    y,
    rawZ: item.z,
    rawY: item.y,
    rawA: item.a,
    rawB: item.b,
    rawTime: item.t,
    rawEx: item.ex,
    yesterday: y,
    open,
    high,
    low,
    ask,
    bid,
    volume: parseNumber(item.v),
    time: item.t || "",
    date: normalizedDate,
    rawDate,
    change,
    changePercent,
    priceType,
    isRealtimePrice,
    source: "TWSE MIS"
  };
}

function parsePrice(value) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  if (!str || str === "-" || str.toLowerCase() === "null") return null;
  const num = Number(str.replaceAll(",", ""));
  return Number.isFinite(num) ? num : null;
}

function parseNumber(value) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  if (!str || str === "-" || str.toLowerCase() === "null") return null;
  const num = Number(str.replaceAll(",", ""));
  return Number.isFinite(num) ? num : null;
}

function parseFirstOrderPrice(value) {
  if (value === undefined || value === null) return null;
  const parts = String(value).split("_").map(v => parsePrice(v)).filter(v => Number.isFinite(v) && v > 0);
  return parts.length ? parts[0] : null;
}

function normalizeTwseDate(value) {
  const str = String(value || "").trim();
  if (/^\d{8}$/.test(str)) {
    return `${str.substring(0, 4)}-${str.substring(4, 6)}-${str.substring(6, 8)}`;
  }
  if (/^\d{4}[-/]\d{2}[-/]\d{2}/.test(str)) {
    return str.replaceAll("/", "-").substring(0, 10);
  }
  return "";
}

function getUserAgent() {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
      "Pragma": "no-cache"
    },
    body: JSON.stringify(body)
  };
}

// ==========================================
// 【新增】：判斷是否為台灣股市盤中 (09:00 - 13:35)
// ==========================================
function isMarketOpen() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  const day = now.getDay();
  if (day === 0 || day === 6) return false; // 週末不抓 Yahoo
  
  const time = now.getHours() * 100 + now.getMinutes();
  return time >= 900 && time <= 1335;
}

// ==========================================
// 【優化】：呼叫 Yahoo Finance API 批次抓取即時價格
// ==========================================
async function fetchYahooQuotesBatch(missingItems) {
  if (missingItems.length === 0) return {};

  // 組合 Yahoo 格式的代號，例如: "2330.TW,8069.TWO"
  const yahooSymbols = missingItems.map(item => 
    `${item.symbol}${item.market === "otc" ? ".TWO" : ".TW"}`
  ).join(",");

  // 使用 v7 的 quote endpoint 來支援批次查詢
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${yahooSymbols}`;
  
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": getUserAgent() }
    });
    if (!res.ok) return {};
    
    const data = await res.json();
    const resultMap = {};
    
    // 解析回傳結果
    const results = data?.quoteResponse?.result || [];
    results.forEach(quote => {
      // 將 Yahoo 代號轉回台股代號 (去掉 .TW / .TWO)
      const cleanSymbol = quote.symbol.replace(".TW", "").replace(".TWO", "");
      if (quote.regularMarketPrice) {
        resultMap[cleanSymbol] = quote.regularMarketPrice;
      }
    });

    return resultMap;
  } catch (e) {
    console.error("Yahoo Batch API 失敗:", e.message);
    return {};
  }
}
