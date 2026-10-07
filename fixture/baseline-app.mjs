// Fixture for baseline tests: an app shell with inner scrollers, fixed chrome and overlays,
// plus plain document pages and failing routes. `variant` swaps one small thing so tests
// can prove a change is found at exactly one route × viewport × part.
//
//   variant "b"      a row far below the fold of the feed scroller turns hot (class change, no layout change)
//   variant "header" the fixed header changes colour (visible in `top` only)
//   variant "more"   one more row at the end of the feed (that scroller grows)
//   variant "gone"   /about-us answers 404
//   variant "digit"  /report: the footer price (16 px, far below the fold) changes by one digit
//   variant "label"  /report: the label colour moves one Tailwind step (#374151 → #4b5563)
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
.bodyscroll{height:100vh;overflow:auto}
html:has(.bodyscroll){overflow:hidden;height:100%}
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

const page = (body, { bodyClass = "", script = "", style = "" } = {}) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title><style>${css}${style}</style></head><body class="${bodyClass}">${body}${script ? `<script>${script}</script>` : ""}</body></html>`;

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
  if (route === "/report")
    // A tall ordinary document: a one-digit change in its footer is a few pixels of millions.
    return page(
      `<h1>Report</h1><p style="margin:0 16px;font-size:14px;color:${variant === "label" ? "#4b5563" : "#374151"}">Valuation estimate</p>
       ${'<div class="block"></div>'.repeat(11)}
       <p style="margin:0 16px;font-size:16px">Footer price: CHF ${variant === "digit" ? "1'250'800" : "1'250'000"}</p>`,
    );
  if (route === "/short") return page(`<h1>Short page</h1><p>Nothing scrolls here.</p>`);
  if (route === "/widgets")
    // Scroll areas that are not content surfaces (textarea, 20 px strip) must not become parts.
    return page(`<textarea style="width:200px;height:60px">${"line\n".repeat(30)}</textarea>
      <div style="height:20px;overflow:auto"><div style="height:200px">strip</div></div>
      <div style="width:20px;height:200px;overflow:auto"><div style="height:800px;width:100px">narrow</div></div>
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
  if (route === "/prescrolled" || route === "/unscrolled") {
    // An inner scroller that is already scrolled when the page loads (/prescrolled) must be captured
    // exactly like its twin that is not (/unscrolled): from its top.
    const box = `<div id="s" style="height:200px;width:300px;overflow:auto">${rows(30, "Line")}</div>`;
    return page(box, { script: route === "/prescrolled" ? `document.getElementById('s').scrollTop = 300;` : "" });
  }
  if (route === "/autoscroll")
    // An inner scroller that scrolls itself to its end over ~3 s (the page does not move); a red bar appears when it is done.
    return page(`<div id="m" style="height:40px"></div><div id="s" style="height:200px;width:300px;overflow:auto">${rows(30, "Line")}</div>`, {
      script: `const s = document.getElementById('s'); let n = 0;
        const t = setInterval(() => {
          s.scrollTop = Math.min(500, ++n * 17);
          if (n >= 30) { clearInterval(t); document.getElementById('m').style.background = '#c00'; }
        }, 100);`,
    });
  if (route === "/bodyscroll")
    // The body is the scroll container (html cannot scroll): the content must still be captured.
    return page(`<h1>Body scrolls</h1>${rows(60, "Row")}`, { bodyClass: "bodyscroll" });
  if (route === "/bodyprescrolled")
    // /bodyscroll, but the body is already scrolled at load: it must be captured from its top, like /bodyscroll.
    return page(`<h1>Body scrolls</h1>${rows(60, "Row")}`, { bodyClass: "bodyscroll", script: "document.body.scrollTop = 400;" });
  if (route === "/bodyhtmlauto")
    // <html> keeps its own overflow, so the body's overflow stays the body's: the body is a scroller.
    return page(`<h1>Body scrolls inside a scrolling html</h1>${rows(60, "Row")}`, {
      style: "html{overflow:auto;height:100%}body{height:100vh;overflow:auto}",
    });
  if (route === "/bodypct")
    // Common reset CSS: html and body 100 % high, body overflow-x hidden. <html> is not set, so the overflow
    // moves to the viewport and the page scrolls: a page part, and no scroller.
    return page(`<h1>Ordinary page</h1>${rows(60, "Row")}`, {
      style: "html{height:100%}body{height:100%;overflow-x:hidden}",
    });
  if (route === "/bodyscrollbar")
    // body{overflow-y:scroll} (forced scrollbar) on an ordinary page: same propagation, no scroller.
    return page(`<h1>Ordinary page</h1>${rows(60, "Row")}`, { style: "body{overflow-y:scroll}" });
  if (route === "/pagescrolled" || route === "/pageunscrolled")
    // The document itself is scrolled at load (/pagescrolled): top and page parts must match its twin.
    return page(`<h1>Document</h1>${'<div class="block"></div>'.repeat(10)}`, {
      script: route === "/pagescrolled" ? "window.scrollTo(0, 600);" : "",
    });
  if (route === "/scrollclass")
    // overflow-y:scroll (not auto) is a scroller too.
    return page(`<div style="height:200px;width:300px;overflow-y:scroll">${rows(20, "Line")}</div>`);
  if (route === "/slack")
    // Overflow of 10 px is a scroller (captured from 2 px on); 1 px is rounding, not a scroller.
    return page(`<div style="height:200px;width:300px;overflow:auto"><div style="height:210px">ten px</div></div>
      <div style="height:200px;width:300px;overflow:auto"><div style="height:201px">one px</div></div>`);
  if (route === "/slackrestless")
    // A scroller with only ~10 px to scroll keeps changing its content (no network, the document does not move):
    // the settle check must see it, as it sees /restless.
    return page(`<div style="height:200px;width:300px;overflow:auto"><div id="box" style="height:210px;background:#e8e8f4"></div></div>`, {
      script: `let n = 0; setInterval(() => { document.getElementById('box').style.height = 210 + (n++ % 2) * 5 + 'px'; }, 40);`,
    });
  if (route === "/hiddenmenu")
    // Shapes taken from en.wikipedia.org (Vector dropdowns: visibility:hidden, opacity:0, absolute, a few px high,
    // content taller) and bbc.com (off-canvas navigation drawer: visibility:hidden, fixed, full height), plus a collapsed
    // section (content-visibility:hidden: its scroller keeps visibility:visible but has no rendered box).
    // Neither is visible, so neither is a scroller; the visible one beside them is the only part.
    return page(
      `<header class="wiki"><div class="vector-dropdown"><label>Languages</label>
         <div class="vector-dropdown-content">${rows(12, "Language")}</div></div></header>
       <div class="DrawerContentStyled" role="dialog" aria-hidden="true">${rows(60, "Menu entry")}</div>
       <section class="collapsed"><div class="inner-list">${rows(20, "Collapsed entry")}</div></section>
       <main><h1>Article</h1><div style="height:200px;width:300px;overflow:auto" id="real">${rows(20, "Line")}</div></main>`,
      {
        style: `.wiki{position:relative;height:40px}
          .vector-dropdown-content{visibility:hidden;opacity:0;position:absolute;top:36px;right:0;width:218px;max-height:32px;overflow-y:auto;background:#fff}
          .collapsed{content-visibility:hidden;contain-intrinsic-size:300px 200px}
          .inner-list{height:200px;width:300px;overflow:auto}
          .DrawerContentStyled{visibility:hidden;position:fixed;top:0;bottom:0;left:0;width:min(320px,100vw);overflow-y:auto;background:#fff;z-index:9}`,
      },
    );
  if (route === "/hiddenrestless" || route === "/zerorestless" || route === "/roundrestless") {
    // Scrollers that are not parts — hidden, no box (no height, no width), or 1 px of rounding — whose content keeps changing
    // must not keep the page from settling.
    const scroller = {
      "/hiddenrestless": [`visibility:hidden;height:100px;width:300px`],
      "/zerorestless": [`height:0;width:300px`, `height:100px;width:0`],
      "/roundrestless": [`height:200px;width:300px`],
    }[route];
    const boxes = scroller.map((style, i) => `<div style="${style};overflow:auto"><div class="in" style="width:50px;height:${route === "/roundrestless" ? 200 : 400}px"></div></div>`);
    return page(`<h1>Calm page</h1>${boxes.join("")}`, {
      script: `let n = 0; setInterval(() => { const odd = n++ % 2; for (const e of document.querySelectorAll('.in')) e.style.height = ${route === "/roundrestless" ? "200" : "400"} + odd * ${route === "/roundrestless" ? 1 : 10} + 'px'; }, 40);`,
    });
  }
  if (route === "/collapsing")
    // Shape taken from theguardian.com (mobile): a visible scroller whose content is absolutely positioned. Grown to
    // content height it collapses to 0 px — no picture is possible; the scroller beside it is still captured.
    return page(
      `<div style="height:200px;width:300px;overflow:auto;position:relative"><div style="position:absolute;top:0;left:0;width:100%;height:600px;background:#e8e8f4">absolute</div></div>
       <div style="height:200px;width:300px;overflow:auto">${rows(20, "Line")}</div>`,
    );
  if (route === "/partial")
    // A visible title stays in the flow, the long content does not: grown, the box is a 30 px strip of a 630 px scroller.
    return page(
      `<div style="height:200px;width:300px;overflow:auto;position:relative"><div style="height:30px">Title</div><div style="position:absolute;top:30px;left:0;width:100%;height:600px;background:#e8e8f4">absolute</div></div>`,
    );
  if (route === "/partial70" || route === "/partial95")
    // The edge of «a strip»: 420 of 600 px (70 %) stay in the flow → skipped; 570 of 600 px (95 %) → captured.
    return page(
      `<div style="height:200px;width:300px;overflow:auto;position:relative"><div style="height:${route === "/partial70" ? 420 : 570}px;background:#e8e8f4">in the flow</div><div style="position:absolute;top:0;left:0;width:10px;height:600px">x</div></div>`,
    );
  if (route === "/vanish")
    // A script removes the scroller as soon as anything touches its style.
    return page(`<div id="s" style="height:200px;width:300px;overflow:auto">${rows(20, "Line")}</div>`, {
      script: `const s = document.getElementById('s');
        new MutationObserver(() => s.remove()).observe(s, { attributes: true, attributeFilter: ['style'] });`,
    });
  if (route === "/clipy")
    // <html> clips y: not visible in both axes, so the body keeps its own overflow and scrolls by itself.
    return page(`<h1>Body scrolls</h1>${rows(60, "Row")}`, {
      style: "html{overflow-y:clip}body{height:100vh;overflow-y:auto}",
    });
  if (route === "/rehiding")
    // A script hides the scroller again as soon as anything touches its style: it never becomes visible for a picture.
    return page(`<div id="s" style="height:200px;width:300px;overflow:auto">${rows(20, "Line")}</div>`, {
      script: `const s = document.getElementById('s'); let done = false;
        new MutationObserver(() => { if (done) return; done = true; s.style.setProperty('visibility', 'hidden', 'important'); })
          .observe(s, { attributes: true, attributeFilter: ['style'] });`,
    });
  if (route === "/clipx")
    // <html> clips only x: it is not visible in both axes, so the body keeps its own overflow and is the scroller
    // (checking overflow-y alone lost the body's content: neither a page nor a scroller).
    return page(`<h1>Ordinary page</h1>${rows(60, "Row")}`, {
      style: "html{overflow-x:clip}body{height:100vh;overflow-y:auto}",
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
