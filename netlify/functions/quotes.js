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
  /*
    TWSE MIS 通常需要先進首頁取得 cookie / session。
    沒有先取 cookie 時，serverless 環境容易拿到不穩定結果。
  */
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

  /*
    TWSE MIS 的 ex_ch：
    上市：tse_2330.tw
    上櫃：otc_8069.tw

    因為使用者只傳代號，這裡上市 / 上櫃都查。
  */
  const exChList = [];

  symbols.forEach(symbol => {
    exChList.push(`tse_${symbol}.tw`);
    exChList.push(`otc_${symbol}.tw`);
  });

  /*
    一次查多檔比 Promise.all 每檔打兩次穩定，也比較不容易被擋。
  */
const apiUrl =
  `https://mis.twse.com.tw/stock/api/getStockInfo.jsp` +
  `?ex_ch=${exChList.join("|")}` +
  `&json=1` +
  `&delay=0` +
  `&odd=1` +
  `&_=${Date.now()}`;
console.log("TWSE MIS API URL:", apiUrl);



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
  const symbol = normalizeSymbol(item.c);
  if (!symbol) return;

  console.log("TWSE RAW ITEM", {
    symbol,
    ex: item.ex,
    c: item.c,
    n: item.n,
    z: item.z,
    y: item.y,
    o: item.o,
    h: item.h,
    l: item.l,
    a: item.a,
    b: item.b,
    v: item.v,
    t: item.t,
    d: item.d,
    raw: item
  });

  const parsed = parseTwseMisItem(item);

    if (!parsed) return;

    const existing = results[symbol];

    if (!existing) {
      results[symbol] = parsed;
      return;
    }

    /*
      優先保留有即時成交價的資料。
    */
    if (!existing.isRealtimePrice && parsed.isRealtimePrice) {
      results[symbol] = parsed;
    }
  });

  return results;
}

function parseTwseMisItem(item) {
  const symbol = normalizeSymbol(item.c);
  if (!symbol) return null;

  const z = parsePrice(item.z); // 最近成交價
  const y = parsePrice(item.y); // 昨收價
  const open = parsePrice(item.o);
  const high = parsePrice(item.h);
  const low = parsePrice(item.l);

  const ask = parseFirstOrderPrice(item.a);
  const bid = parseFirstOrderPrice(item.b);

 /*
  價格邏輯：
  1. 優先使用最近成交價 z
  2. 若 z 無效，使用昨收 y
  3. 不使用 bid / ask
*/
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

  const parts = String(value)
    .split("_")
    .map(v => parsePrice(v))
    .filter(v => Number.isFinite(v) && v > 0);

  return parts.length ? parts[0] : null;
}

function normalizeTwseDate(value) {
  const str = String(value || "").trim();

  /*
    TWSE MIS 常見格式：20260721
  */
  if (/^\d{8}$/.test(str)) {
    return `${str.substring(0, 4)}-${str.substring(4, 6)}-${str.substring(6, 8)}`;
  }

  /*
    已經是 2026-07-21 或 2026/07/21。
  */
  if (/^\d{4}[-/]\d{2}[-/]\d{2}/.test(str)) {
    return str.replaceAll("/", "-").substring(0, 10);
  }

  return "";
}

function getUserAgent() {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",

      /*
        關鍵：避免 Netlify / CDN / browser 快取。
      */
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
      "Surrogate-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}
// 判斷現在是否為台灣股市盤中 (09:00 - 13:35)
function isMarketOpen() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  const day = now.getDay();
  // 週末不抓 Yahoo
  if (day === 0 || day === 6) return false; 
  
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const time = hours * 100 + minutes;
  
  // 09:00 到 13:35 (包含盤後零股緩衝時間)
  return time >= 900 && time <= 1335;
}

// 呼叫 Yahoo Finance API
async function fetchYahooQuote(symbol, market) {
  // 根據上市/上櫃加上正確的後綴
  const suffix = market === "otc" ? ".TWO" : ".TW";
  const yahooSymbol = `${symbol}${suffix}`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1m&range=1d`;
  
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": getUserAgent() }
    });
    if (!res.ok) return null;
    const data = await res.json();
    // 取得 Yahoo 的即時價格
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return Number.isFinite(price) ? price : null;
  } catch (e) {
    console.error(`Yahoo API 失敗 (${yahooSymbol}):`, e.message);
    return null;
  }
}
