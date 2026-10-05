// Fixture for baseline tests: an app shell with inner scrollers, fixed chrome and overlays,
// plus plain document pages and failing routes. `variant` swaps one small thing so tests
// can prove a change is found at exactly one route × viewport × part.
//
//   variant "b"      a row far below the fold of the feed scroller turns hot (class change, no layout change)
//   variant "header" the fixed header changes colour (visible in `top` only)
//   variant "more"   one more row at the end of the feed (that scroller grows)
//   variant "gone"   /about-us answers 404
import { createServer } from "node:http";

const css = `
*{box-sizing:border-box}
body{margin:0;font:16px/1.4 Arial,sans-serif;color:#111;background:#fff}
.shell{overflow:hidden;height:100vh}
.top{position:fixed;top:0;left:0;right:0;height:48px;background:#123;color:#fff;padding:12px 16px;z-index:5}
.top-warn{background:#a30}
.rail{position:fixed;top:48px;left:0;bottom:0;width:160px;background:#eef;padding:12px;z-index:4}
.feed{position:absolute;top:48px;left:160px;right:360px;bottom:0;overflow-y:auto;padding:8px 16px;background:#fff}
.thread{position:fixed;top:48px;right:0;width:360px;bottom:56px;overflow-y:auto;background:#fafafa;padding:8px 16px;z-index:3}
.composer{position:fixed;bottom:0;right:0;width:360px;height:56px;background:#ddd;padding:12px;z-index:6}
.cookie{position:fixed;bottom:8px;left:176px;background:#222;color:#fff;padding:12px;z-index:7}
.row{padding:10px 0;border-bottom:1px solid #ccc}
.row-hot{background:#fc0}
.spin{width:24px;height:24px;background:#06c;animation:turn 1s linear infinite}
@keyframes turn{to{transform:rotate(360deg)}}
.fade{transition:opacity .4s;opacity:.2}
.fade.on{opacity:1}
.block{height:300px;margin:0 16px 16px;background:#e8e8f4}
#box{height:100px;background:#eee}
#rm{height:50px;background:#c00}
@media(prefers-reduced-motion:reduce){#rm{background:#0c0}}
.loaded #box{height:300px;background:#0a6}
@media(max-width:700px){.rail,.thread,.composer{display:none}.feed{left:0;right:0}}
`;

const rows = (n, label, hot = -1) =>
  Array.from({ length: n }, (_, i) => `<div class="row${i === hot ? " row-hot" : ""}">${label} ${i + 1}</div>`).join("");

const page = (body, { bodyClass = "", script = "" } = {}) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title><style>${css}</style></head><body class="${bodyClass}">${body}${script ? `<script>${script}</script>` : ""}</body></html>`;

const clockScript = `
const t = document.getElementById('now');
const show = () => (t.textContent = new Date().toLocaleString() + ' ' + new Date().getMilliseconds());
show(); setInterval(show, 50);
setTimeout(() => document.querySelector('.fade').classList.add('on'), 100);
`;

export function render(route, variant = "") {
  if (variant === "gone" && route === "/about-us") return null;
  if (route === "/") {
    return page(
      `<header class="top${variant === "header" ? " top-warn" : ""}">Acme Console</header>
       <nav class="rail">Inbox<br>Sent</nav>
       <main class="feed">${rows(40 + (variant === "more" ? 1 : 0), "Feed row", variant === "b" ? 34 : -1)}</main>
       <aside class="thread">${rows(30, "Message")}</aside>
       <div class="composer"><input autofocus aria-label="Reply" value="draft"></div>
       <div class="cookie">We use cookies</div>
       <div class="spin"></div><div class="fade">fading in</div><span id="now"></span>`,
      { bodyClass: "shell", script: clockScript },
    );
  }
  if (route === "/long")
    return page(`<h1>Long page</h1>${'<div class="block"></div>'.repeat(10)}<span id="now"></span><div class="fade"></div>`, { script: clockScript });
  if (route === "/short") return page(`<h1>Short page</h1><p>Nothing scrolls here.</p>`);
  if (route === "/widgets")
    // Scroll areas that are not content surfaces (textarea, 20 px strip) must not become parts.
    return page(`<textarea style="width:200px;height:60px">${"line\n".repeat(30)}</textarea>
      <div style="height:20px;overflow:auto"><div style="height:200px">strip</div></div>
      <div style="height:200px;overflow:auto;width:300px"><div style="position:sticky;top:0;background:#ff0">sticky inside</div><div style="height:600px">real scroller</div></div>`);
  if (route === "/fetching")
    // Content that arrives over the network after load (700 ms): only network idle waits for it.
    return page(`<div id="box"></div>`, {
      script: `fetch('/api/slow').then(() => document.body.classList.add('loaded'));`,
    });
  if (route === "/timer")
    // Layout change with no network or font behind it, 800 ms after load: only the settle loop catches it.
    return page(`<div id="box"></div>`, { script: `setTimeout(() => document.body.classList.add('loaded'), 800);` });
  if (route === "/motion")
    // Red unless the browser was asked for reduced motion; a spinner that never stops.
    return page(`<div id="rm"></div><div class="spin" style="margin:20px"></div>`);
  if (route === "/vanishing")
    // The scroller disappears as soon as it is marked: a failure inside one part must not take the run down.
    return page(`<div id="s" style="height:100px;width:300px;overflow:auto"><div style="height:400px">scroll</div></div>`, {
      script: `new MutationObserver(() => { const s = document.getElementById('s'); if (s && s.hasAttribute('data-vqa-scroller')) s.remove(); })
        .observe(document.body, { attributes: true, subtree: true });`,
    });
  if (route === "/restless")
    return page(`<div id="box"></div>`, {
      script: `let n = 0; setInterval(() => { document.getElementById('box').style.height = 900 + (n++ % 2) * 10 + 'px'; }, 40);`,
    });
  if (route === "/about-us") return page(`<h1>About us</h1><p>Hyphen route.</p>`);
  if (route === "/late")
    return page(`<div id="box"></div>`, {
      script: `const ready = new Promise((r) => setTimeout(() => { document.body.classList.add('loaded'); r(); }, 1200));
        Object.defineProperty(document.fonts, 'ready', { get: () => ready });`,
    });
  return null;
}

/** Starts the fixture on a free port. `setVariant(v)` changes what the next request sees. */
export async function startBaselineApp() {
  let variant = "";
  const server = createServer((req, res) => {
    const route = new URL(req.url, "http://x").pathname;
    if (route === "/boom") {
      res.writeHead(500, { "content-type": "text/html" });
      return res.end("<h1>boom</h1>");
    }
    if (route === "/drop") return req.socket.destroy();
    if (route === "/api/slow") return setTimeout(() => res.end("ok"), 700);
    const html = render(route, variant);
    if (html === null) {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end("<h1>not found</h1>");
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    setVariant: (v) => {
      variant = v;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
