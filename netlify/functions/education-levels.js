// netlify/functions/education-levels.js
// Proxy tới Google Apps Script, ẩn token trong ENV (EDUCATION_API_TOKEN)
const BASE_URL = "https://script.google.com/macros/s/AKfycbw70NAsy37pZ3mvvqNUZAJBEThLg-BZcuMvNztNBI3psu-MV7ELGs1RSwClOOV1MrFFMg/exec";

// Cho phép CORS từ các origin nhất định (ENV: ALLOWED_ORIGINS, ví dụ: "https://<user>.github.io,https://<your-site>.netlify.app")
// Mặc định "*" (mọi origin) nếu không cấu hình.
const ALLOWED = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function originAllowed(event) {
  const origin = event.headers?.origin || "";
  if (ALLOWED.includes("*")) return origin || "*";
  return ALLOWED.includes(origin) ? origin : null;
}

function corsHeaders(origin) {
  return {
    ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function normalizeItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.items)) return payload.items;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && payload.result && Array.isArray(payload.result)) return payload.result;
  return [];
}

exports.handler = async function(event) {
  const origin = originAllowed(event);

  if (event.httpMethod === "OPTIONS") {
    // Preflight CORS
    return { statusCode: 204, headers: corsHeaders(origin) };
  }

  try {
    const token = process.env.EDUCATION_API_TOKEN;
    if (!token) {
      return {
        statusCode: 500,
        headers: corsHeaders(origin),
        body: JSON.stringify({ error: "Thiếu cấu hình token phía server." })
      };
    }

    // Chặn origin không hợp lệ (nếu bạn không muốn mở * toàn bộ)
    if (!origin && !ALLOWED.includes("*")) {
      return { statusCode: 403, headers: {}, body: JSON.stringify({ error: "Origin không được phép." }) };
    }

    const method = event.httpMethod;
    const url = new URL(BASE_URL);

    if (method === "GET") {
      // Lấy danh sách và lọc/giới hạn tại serverless
      url.searchParams.set("action", "get");
      url.searchParams.set("token", token);

      const qp = event.queryStringParameters || {};
      const codeFilter = (qp.code || "").toString();
      if (codeFilter) url.searchParams.set("code", codeFilter);

      const upstream = await fetch(url.toString());
      const data = await upstream.json().catch(() => null);
      if (!upstream.ok) {
        const msg = data && data.error ? data.error : `Upstream error ${upstream.status}`;
        return { statusCode: upstream.status, headers: corsHeaders(origin), body: JSON.stringify({ error: msg }) };
      }

      let items = normalizeItems(data);

      const nameQ = (qp.name || "").toString().toLowerCase();
      const codeQ = (qp.code || "").toString().toLowerCase();
      const uuidQ = (qp.uuid || "").toString();
      const limitQ = parseInt(qp.limit || "0", 10);

      if (uuidQ) {
        items = items.filter(r => (r.UUID || r.uuid || r.id || r.Id) === uuidQ);
      } else {
        if (nameQ) items = items.filter(r => String(r.Name || r.name || "").toLowerCase().includes(nameQ));
        if (codeQ) items = items.filter(r => String(r.Code || r.code || "").toLowerCase().includes(codeQ));
        if (limitQ > 0 && items.length > limitQ) {
          // "10 bản ghi mới nhất (từ dưới lên)" => lấy từ cuối danh sách rồi đảo để bản mới nhất lên đầu
          items = items.slice(-limitQ).reverse();
        }
      }

      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify({ items }) };
    }

    // Ghi (insert/edit/delete): forward body JSON
    const body = event.body ? JSON.parse(event.body) : {};
    let action = "";
    if (method === "POST") action = "insert";
    else if (method === "PATCH") action = "edit";
    else if (method === "DELETE") action = "delete";
    else {
      return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify({ error: "Method Not Allowed" }) };
    }

    url.searchParams.set("action", action);
    url.searchParams.set("token", token);

    const upstream = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });

    const text = await upstream.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    if (!upstream.ok || (json && json.error)) {
      const msg = json && json.error ? json.error : `Upstream error ${upstream.status}`;
      return {
        statusCode: upstream.status || 500,
        headers: corsHeaders(origin),
        body: JSON.stringify({ error: msg, ...(typeof json === 'object' ? json : {}) })
      };
    }

    return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(json) };

  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders(originAllowed(event)),
      body: JSON.stringify({ error: err.message || "Internal error" })
    };
  }
};
