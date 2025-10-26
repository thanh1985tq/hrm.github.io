// netlify/functions/education-levels.js
const BASE_URL = "https://script.google.com/macros/s/AKfycbw8OoNMgbEcFP63N77bvjOdjW5vbNW4GyLmGlJ9qEf6yo1akWXxJhc2ps-7CkL6YJHhSQ/exec";

// Build allowed origin set (normalized)
function normalizeOrigin(s) {
  if (!s) return "";
  try { return new URL(s).origin.toLowerCase(); }
  catch { return String(s).replace(/\/+$/, "").toLowerCase(); }
}
const ALLOWED_SET = new Set(
  (process.env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(normalizeOrigin)
);

function getOriginHeader(headers) {
  return (headers?.origin || headers?.Origin || "").toString();
}
function corsHeaders(originHeader) {
  const headers = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
  // Only echo ACAO if client sent Origin AND it's allowed
  const normalized = normalizeOrigin(originHeader);
  if (originHeader && (ALLOWED_SET.has("*") || ALLOWED_SET.has(normalized))) {
    headers["Access-Control-Allow-Origin"] = originHeader;
  }
  return headers;
}
function normalizeItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.items)) return payload.items;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && payload.result && Array.isArray(payload.result)) return payload.result;
  return [];
}

exports.handler = async function(event) {
  const originHeader = getOriginHeader(event.headers);
  const isAllowed =
    !originHeader || // allow when Origin header is missing (same-origin GET)
    ALLOWED_SET.has("*") ||
    ALLOWED_SET.has(normalizeOrigin(originHeader));

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(originHeader) };
  }
  if (!isAllowed) {
    return { statusCode: 403, headers: corsHeaders(originHeader), body: JSON.stringify({ error: "Origin không được phép." }) };
  }

  try {
    const token = process.env.EDUCATION_API_TOKEN;
    if (!token) {
      return { statusCode: 500, headers: corsHeaders(originHeader), body: JSON.stringify({ error: "Thiếu cấu hình token phía server." }) };
    }

    const method = event.httpMethod;
    const url = new URL(BASE_URL);

    if (method === "GET") {
      url.searchParams.set("action", "get");
      url.searchParams.set("token", token);

      const qp = event.queryStringParameters || {};
      const codeFilter = (qp.code || "").toString();
      if (codeFilter) url.searchParams.set("code", codeFilter);

      const upstream = await fetch(url.toString());
      const data = await upstream.json().catch(() => null);
      if (!upstream.ok) {
        const msg = data && data.error ? data.error : `Upstream error ${upstream.status}`;
        return { statusCode: upstream.status, headers: corsHeaders(originHeader), body: JSON.stringify({ error: msg }) };
      }

      let items = normalizeItems(data);
      const nameQ = (qp.name || "").toLowerCase();
      const codeQ = (qp.code || "").toLowerCase();
      const uuidQ = (qp.uuid || "");
      const limitQ = parseInt(qp.limit || "0", 10);

      if (uuidQ) {
        items = items.filter(r => (r.UUID || r.uuid || r.id || r.Id) === uuidQ);
      } else {
        if (nameQ) items = items.filter(r => String(r.Name || r.name || "").toLowerCase().includes(nameQ));
        if (codeQ) items = items.filter(r => String(r.Code || r.code || "").toLowerCase().includes(codeQ));
        if (limitQ > 0 && items.length > limitQ) items = items.slice(-limitQ).reverse(); // newest from bottom up
      }

      return { statusCode: 200, headers: corsHeaders(originHeader), body: JSON.stringify({ items }) };
    }

    // Write ops -> forward as JSON
    const body = event.body ? JSON.parse(event.body) : {};
    let action = "";
    if (method === "POST") action = "insert";
    else if (method === "PATCH") action = "edit";
    else if (method === "DELETE") action = "delete";
    else return { statusCode: 405, headers: corsHeaders(originHeader), body: JSON.stringify({ error: "Method Not Allowed" }) };

    url.searchParams.set("action", action);
    url.searchParams.set("token", token);

    const upstream = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });

    const text = await upstream.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }

    if (!upstream.ok || (json && json.error)) {
      const msg = json && json.error ? json.error : `Upstream error ${upstream.status}`;
      return { statusCode: upstream.status || 500, headers: corsHeaders(originHeader), body: JSON.stringify({ error: msg, ...(typeof json === 'object' ? json : {}) }) };
    }

    return { statusCode: 200, headers: corsHeaders(originHeader), body: JSON.stringify(json) };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders(originHeader), body: JSON.stringify({ error: err.message || "Internal error" }) };
  }
};
