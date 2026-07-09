// Vercel serverless function — proxies golfcourseapi.com so:
//  1. The API key stays server-side (never shipped to browsers)
//  2. No CORS issues (same-origin request from the app's perspective)
export default async function handler(req, res) {
  const KEY = process.env.GOLF_API_KEY;
  if (!KEY) return res.status(500).json({ error: "GOLF_API_KEY env var not set" });

  const { path = "", q = "", id = "" } = req.query;

  let url;
  if (path === "search")      url = `https://api.golfcourseapi.com/v1/search?search_query=${encodeURIComponent(q)}`;
  else if (path === "course") url = `https://api.golfcourseapi.com/v1/courses/${encodeURIComponent(id)}`;
  else return res.status(400).json({ error: "path must be 'search' or 'course'" });

  try {
    const r    = await fetch(url, { headers: { Authorization: `Key ${KEY}` } });
    const data = await r.json();
    // Cache course data at the edge for a day — scorecards rarely change
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate");
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: `Upstream error: ${e.message}` });
  }
}
