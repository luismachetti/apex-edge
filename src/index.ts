/// <reference types="@fastly/js-compute" />

import { KVStore } from "fastly:kv-store";
import { SecretStore } from "fastly:secret-store";

/**
 * Bindings — match your Fastly Resources exactly (no hyphens).
 * Make sure each store shows “Services linked: 1” for this service.
 */
const SESS   = new KVStore("apexsessions");
const DEALS  = new KVStore("apexdeals");
const ASSESS = new KVStore("apexassess");
const USAGE  = new KVStore("apexusage");
const SECRETS = new SecretStore("apexsecrets");

/* ---------- tiny helpers ---------- */
const TEXT = (s: string, status = 200, headers: HeadersInit = {}) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });

const HTML = (s: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Apex</title>
<style>
  :root{color-scheme:light dark}
  body{font-family:Inter,system-ui,sans-serif;margin:24px;max-width:900px}
  .btn{padding:10px 14px;border:1px solid #ddd;border-radius:12px;background:#fff;cursor:pointer}
  input,select,textarea{display:block;margin:6px 0 14px;padding:8px 10px;border:1px solid #ddd;border-radius:10px;width:320px}
  a{color:inherit} hr{margin:18px 0}
  ul{padding-left:18px}
</style>
${s}`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );

const rnd = () => crypto.randomUUID();

function cookieGet(req: Request, name: string) {
  const c = req.headers.get("cookie") || "";
  const m = c.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : "";
}
function cookieSet(name: string, value: string, days = 7) {
  const exp = new Date(Date.now() + days * 864e5).toUTCString();
  return `${name}=${encodeURIComponent(value)}; Path=/; Expires=${exp}; HttpOnly; Secure; SameSite=Lax`;
}

async function getSecret(name: string): Promise<string | null> {
  const s = await SECRETS.get(name);
  return s ? await s.text() : null;
}

/* ---------- session helpers ---------- */
type SessionUser = { sub: string; email?: string } | null;

async function getSession(req: Request): Promise<{ id: string; user: SessionUser }> {
  const id = cookieGet(req, "apx");
  if (!id) return { id: "", user: null };
  const e = await SESS.get(`s:${id}`);
  return { id, user: e ? await e.json() : null };
}
async function requireSession(req: Request): Promise<{ id: string; user: NonNullable<SessionUser> }> {
  const s = await getSession(req);
  if (!s.id || !s.user) throw new Response(null, { status: 302, headers: { location: "/" } });
  return s as { id: string; user: NonNullable<SessionUser> };
}

/* ---------- data helpers ---------- */
async function listDeals(userId: string) {
  let cursor: string | undefined;
  const keys: string[] = [];
  do {
    const { list, cursor: c } = await DEALS.list({ prefix: `deal:${userId}:`, cursor, limit: 100 });
    if (list) keys.push(...list);
    cursor = c;
  } while (cursor);
  const out: any[] = [];
  for (const k of keys) {
    const e = await DEALS.get(k);
    if (e) out.push(await e.json());
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

function safeJSON(maybe: string) {
  // Strip common code fences, then parse or fallback
  let s = maybe.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "");
  try {
    return JSON.parse(s);
  } catch {
    return { tier: "Workable", go_hold_nogo: "Hold", total_score: 60, analysis: "Fallback result." };
  }
}

/* ---------- LLM assess ---------- */
async function llmAssess(input: any) {
  const provider = (await getSecret("LLM_PROVIDER")) || "anthropic";
  const model = (await getSecret("LLM_MODEL")) || "claude-3-5-sonnet-20240620";

  const prompt =
    `Return STRICT JSON only with fields:\n` +
    `{"tier":"Strong|Workable|Weak","go_hold_nogo":"Go|Hold|No-go","total_score":0,"analysis":"..."}\n` +
    `Deal input: ${JSON.stringify(input)}`;

  try {
    if (provider === "openai") {
      const key = await getSecret("OPENAI_API_KEY");
      if (!key) throw new Error("Missing OPENAI_API_KEY");
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, temperature: 0.1, messages: [{ role: "user", content: prompt }] }),
      });
      const j = await r.json();
      const txt = j?.choices?.[0]?.message?.content?.trim() || "{}";
      return safeJSON(txt);
    } else {
      const key = await getSecret("ANTHROPIC_API_KEY");
      if (!key) {
        // fall back to heuristic if no key set
        return heuristicScore(input);
      }
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model, temperature: 0.1, max_tokens: 800, messages: [{ role: "user", content: prompt }] }),
      });
      const j = await r.json();
      const txt = j?.content?.[0]?.text?.trim() || "{}";
      return safeJSON(txt);
    }
  } catch (_e) {
    return heuristicScore(input);
  }
}

function heuristicScore(input: any) {
  const vals = Object.values(input?.scores || {}) as number[];
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 3;
  const total = Math.max(0, Math.min(100, Math.round(avg * 20)));
  const tier = total >= 80 ? "Strong" : total >= 60 ? "Workable" : "Weak";
  const decision = total >= 80 ? "Go" : total >= 60 ? "Hold" : "No-go";
  return { tier, go_hold_nogo: decision, total_score: total, analysis: "Heuristic fallback scoring." };
}

/* ---------- router ---------- */
addEventListener("fetch", (event: FetchEvent) => event.respondWith(handle(event.request)));

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;

  // Home (dev login)
  if (req.method === "GET" && p === "/") {
    const { user } = await getSession(req);
    if (user) return new Response(null, { status: 302, headers: { location: "/deals" } });
    return HTML(`
      <h1>Apex (Edge)</h1>
      <p>Dev login for v1 (no emails). Type your email and you’re in.</p>
      <form method="POST" action="/dev-login">
        <input name="email" placeholder="your@company.com" required>
        <button class="btn">Sign in</button>
      </form>
    `);
  }

  if (req.method === "POST" && p === "/dev-login") {
    const form = await req.formData();
    const email = String(form.get("email") || "").toLowerCase().trim();
    if (!email) return TEXT("Email required", 400);
    const sid = rnd();
    await SESS.put(`s:${sid}`, JSON.stringify({ sub: `u:${email}`, email }), { ttl: 60 * 60 * 24 * 7 });
    return new Response(null, { status: 302, headers: { "set-cookie": cookieSet("apx", sid), location: "/deals" } });
  }

  if (req.method === "POST" && p === "/logout") {
    const sid = cookieGet(req, "apx");
    if (sid) await SESS.delete(`s:${sid}`);
    return new Response(null, { status: 302, headers: { "set-cookie": cookieSet("apx", "", -1), location: "/" } });
  }

  // Deals list + create
  if (req.method === "GET" && p === "/deals") {
    const { user } = await requireSession(req);
    const deals = await listDeals(user.sub);
    return HTML(`
      <a href="/logout">Logout</a>
      <h2>My deals</h2>
      <ul>${deals.map((d: any) => `<li><a href="/deal/${d.dealId}">${d.title} — ${d.account} — $${d.value}</a></li>`).join("")}</ul>
      <hr>
      <h3>New deal</h3>
      <form method="POST" action="/deal">
        <input name="account" placeholder="Account" required>
        <input name="title" placeholder="Deal title" required>
        <input name="value" type="number" placeholder="Value USD" required>
        <select name="stage">
          <option>Qualification</option><option>Discovery</option><option>Evaluation</option>
          <option>Paperwork</option><option>Negotiation</option><option>Closed</option>
        </select>
        <button class="btn">Create</button>
      </form>
    `);
  }

  if (req.method === "POST" && p === "/deal") {
    const { user } = await requireSession(req);
    const f = await req.formData();
    const dealId = rnd();
    const doc = {
      userId: user.sub,
      dealId,
      account: String(f.get("account") || "").trim(),
      title: String(f.get("title") || "").trim(),
      value: Number(f.get("value") || 0),
      stage: String(f.get("stage") || "Qualification"),
      lastAssessmentId: null as number | null,
      updatedAt: Date.now(),
    };
    await DEALS.put(`deal:${user.sub}:${dealId}`, JSON.stringify(doc));
    return new Response(null, { status: 302, headers: { location: `/deal/${dealId}` } });
  }

  // Single deal page + assessment form
  if (req.method === "GET" && p.startsWith("/deal/")) {
    const { user } = await requireSession(req);
    const dealId = p.split("/").pop()!;
    const e = await DEALS.get(`deal:${user.sub}:${dealId}`);
    if (!e) return TEXT("Not found", 404);
    const deal = await e.json();
    return HTML(`
      <a href="/deals">← Back</a>
      <h2>${deal.title} — ${deal.account} — $${deal.value}</h2>
      <form method="POST" action="/assess">
        <input type="hidden" name="dealId" value="${deal.dealId}">
        <label>Metrics (1-5) <input name="metrics" type="number" min="1" max="5" required></label>
        <label>Economic Buyer (1-5) <input name="eb" type="number" min="1" max="5" required></label>
        <label>Decision Criteria (1-5) <input name="dc" type="number" min="1" max="5" required></label>
        <label>Decision Process (1-5) <input name="dp" type="number" min="1" max="5" required></label>
        <label>Paper Process (1-5) <input name="pp" type="number" min="1" max="5" required></label>
        <label>Identified Pain (1-5) <input name="ip" type="number" min="1" max="5" required></label>
        <label>Champion (1-5) <input name="ch" type="number" min="1" max="5" required></label>
        <label>Competition (1-5) <input name="co" type="number" min="1" max="5" required></label>
        <textarea name="notes" placeholder="Optional notes"></textarea>
        <button class="btn">Assess & coach</button>
      </form>
    `);
  }

  // Run assessment
  if (req.method === "POST" && p === "/assess") {
    const { user } = await requireSession(req);
    const f = await req.formData();
    const dealId = String(f.get("dealId") || "");
    const e = await DEALS.get(`deal:${user.sub}:${dealId}`);
    if (!e) return TEXT("Deal missing", 404);
    const deal = await e.json();

    const scores = {
      metrics: Number(f.get("metrics") || 0),
      economic_buyer: Number(f.get("eb") || 0),
      decision_criteria: Number(f.get("dc") || 0),
      decision_process: Number(f.get("dp") || 0),
      paper_process: Number(f.get("pp") || 0),
      identified_pain: Number(f.get("ip") || 0),
      champion: Number(f.get("ch") || 0),
      competition: Number(f.get("co") || 0),
    };
    const payload = { account: deal.account, title: deal.title, value: deal.value, stage: deal.stage, scores, notes: String(f.get("notes") || "") };

    const result = await llmAssess(payload);
    const ts = Date.now();
    await ASSESS.put(`assessment:${user.sub}:${dealId}:${ts}`, JSON.stringify({ ...result, createdAt: ts, payload }));

    // update deal summary
    deal.lastAssessmentId = ts;
    deal.lastTier = result.tier;
    deal.lastScore = result.total_score;
    deal.updatedAt = ts;
    await DEALS.put(`deal:${user.sub}:${dealId}`, JSON.stringify(deal));

    // usage counter per month (yyyymm)
    const ym = new Date().toISOString().slice(0, 7).replace("-", "");
    const k = `use:${ym}`;
    let c = 0;
    const cur = await USAGE.get(k);
    if (cur) c = Number(await cur.text());
    await USAGE.put(k, String(c + 1));

    return new Response(null, { status: 302, headers: { location: `/assessment/${dealId}/${ts}` } });
  }

  // View assessment JSON
  if (req.method === "GET" && p.startsWith("/assessment/")) {
    const { user } = await requireSession(req);
    const [, , dealId, ts] = p.split("/");
    const k = `assessment:${user.sub}:${dealId}:${ts}`;
    const e = await ASSESS.get(k);
    if (!e) return TEXT("Not found", 404);
    const a = await e.json();
    return new Response(JSON.stringify(a, null, 2), { headers: { "content-type": "application/json" } });
  }

  if (req.method === "GET" && p === "/health") {
    return new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
  }

  return TEXT("Not found", 404);
}
