// In-memory stand-in for the live database, for testing the page without touching real data.
// Load it before app.js (e.g. Playwright add_init_script). Logins: ben@toca.test (owner), kim@toca.test (editor), new@toca.test (not approved); password "pw".
(function () {
  const users = { "ben@toca.test": "u-owner", "kim@toca.test": "u-kim", "new@toca.test": "u-new" };
  const root = { owner: "u-owner", editors: { "u-kim": { email: "kim@toca.test", t: 1 } }, requests: {}, contests: {} };
  const subs = [];
  const clone = o => (o == null ? null : JSON.parse(JSON.stringify(o)));
  const segs = p => p.split("/").filter(Boolean);
  function get(p) { let o = root; for (const s of segs(p)) { if (o == null || typeof o !== "object") return null; o = o[s]; } return o === undefined ? null : o; }
  function resolve(v) { if (v && typeof v === "object") { if (v[".sv"] === "timestamp") return Date.now(); const o = {}; for (const k in v) o[k] = resolve(v[k]); return o; } return v; }
  function set(p, v) {
    const ss = segs(p); let o = root;
    for (let i = 0; i < ss.length - 1; i++) { if (o[ss[i]] == null || typeof o[ss[i]] !== "object") o[ss[i]] = {}; o = o[ss[i]]; }
    if (v == null) delete o[ss[ss.length - 1]]; else o[ss[ss.length - 1]] = v;
  }
  const emit = () => { const c = clone(root.contests) || {}; setTimeout(() => subs.forEach(f => f(c)), 40); };
  window.CONTEST_MOCK = {
    root,
    api: {
      async req(method, path, body, tok) {
        await new Promise(r => setTimeout(r, 25));
        if (window.MOCK_OFFLINE) throw new TypeError("Failed to fetch");
        const uid = tok ? String(tok).replace(/^tok-/, "") : null;
        const mgr = !!uid && (root.owner === uid || !!(root.editors || {})[uid]);
        if (method === "GET") {
          if (path === "owner" || path.startsWith("contests")) return clone(get(path));
          if (!uid) throw { status: 401 };
          if ((path === "requests" || path === "editors") && root.owner !== uid) throw { status: 401 };
          return clone(get(path));
        }
        if (path.startsWith("contests/") && !mgr) throw { status: 401 };
        if (path.startsWith("editors") && root.owner !== uid) throw { status: 401 };
        if (/^contests\/(entries|draws\/[^/]+)\/[^/]+$/.test(path) && method === "PUT" && get(path) != null) throw { status: 401 };
        if (/\/(x|v)$/.test(path) && get(path) != null) throw { status: 401 };
        if (/\/v$/.test(path) && root.owner !== uid) throw { status: 401 };
        if (method === "PUT") set(path, resolve(body));
        else if (method === "PATCH") set(path, Object.assign({}, get(path) || {}, resolve(body)));
        else if (method === "DELETE") set(path, null);
        if (path.startsWith("contests")) emit();
        return resolve(body === undefined ? null : body);
      },
      listen(onData, onConn) { subs.push(onData); setTimeout(() => { onConn("live"); onData(clone(root.contests) || {}); }, 60); },
      async signIn(email, pw) {
        const u = users[email];
        if (!u || pw !== "pw") throw new Error("That email and password don't match.");
        return { uid: u, email, rt: "rt-" + u, tok: "tok-" + u, exp: Date.now() + 3600e3 };
      },
      async refresh(rt) { return { tok: "tok-" + String(rt).replace(/^rt-/, ""), exp: Date.now() + 3600e3, rt }; }
    }
  };
})();
