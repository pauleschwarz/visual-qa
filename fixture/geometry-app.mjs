// Fixture for the geometry checks: per check one page with the defect built in (`/<check>-bad`) and one
// without (`/<check>-ok`), so a test proves "found" and "no false alarm" on the same shape.
//
//   /first-view-bad   .cta sits below a tall banner: under the fold of any window up to ~700 px
//   /first-view-ok    .cta ends at ~330 px: above the fold of a 400 px window, below a 300 px one
//   /covered-bad      fixed header over the first paragraph, fixed bar over the last link; neither can be scrolled clear
//   /covered-ok       same bars, body padding and scroll-padding leave room
//   /covered-focus-bad  everything can be scrolled clear, but a focused link lands under the fixed bar
//   /covered-focus-ok   same, scroll-padding keeps focused links clear of the bar
//   /stable-bad       #save changes its label and pushes "Cancel" right (trigger: #save)
//   /stable-ok        #save has a fixed width: nothing moves
//   /stable-centered-ok  the trigger itself moves (centred label gets wider): that is not a neighbour
//   /stable-hover-bad hovering .menu opens a tip in the flow and pushes #after down (trigger: hover:.menu)
//   /edges-bad        the second card starts 3 px right of the first
//   /edges-ok         cards flush; a 24 px indent is a design, not an off-by-3
//   /edges-right-bad  two cards flush on the left, right edges 3 px apart
//   /edges-center-ok  centred blocks of slightly different width: centred on purpose
//   /edges-shift      the second card starts `shift` px right (setShift(n)): 1–4 is found, 0 and 5 are not
//   /text-fit-bad     a chip that cuts its text, a name with an ellipsis and no title, a button its label sticks out of
//   /text-fit-ok      the same shapes with room, a title, wrapping
//   /text-fit-clamp-bad a clamped text and a fixed-height box that cut text, no title
//   /text-fit-clamp-ok  the same with a title and room
//   /text-fit-sweep   a chip 30 vw wide: its text is cut only below ~470 px of viewport width
//   /row-align-bad    two texts 2 px apart on one line; two same-sized texts with baselines 3 px apart
//   /row-align-sweep  the gap between two texts is 0.5 vw: under 6 px up to ~1200 px, smallest at the narrowest width
//   /row-align-ok     16 px apart, one baseline
//   /tap-size-bad     28 px icon buttons and two links whose tap areas overlap
//   /tap-size-ok      48 px buttons, a 28 px button whose ::after reaches 52 px, a checkbox with a label, a link in a sentence
//   /tap-size-many    45 small buttons, one overlapping pair, one baseline 1.5 px off: the picture limit must not drop the rare kinds
//   /covered-modal-ok  the covered-bad page with a modal dialog open: a modal covers on purpose
//   /blank            an empty page
//   /tap-size-sheet   a fixed sheet that scrolls over page links: 12 small buttons 40 px apart (they never touch), two links of it that do overlap
//   /tap-size-list    a list that scrolls in a box of 120 px, page links below it: its rows beyond the box overlap them in the page, not on screen
//   /tap-size-late    250 big links, then a 20 px button: nothing may stop the measuring before the button
//   /tap-size-cap     115 small buttons (5 of them 20 px, the rest 28 px) and one overlapping pair: the list is cut, the rare kind is not
//   /tap-size-vary    a button whose height grows with the window (16.4 px at 320, 26 px at 800)
//   /tap-size-wrapped links inside a sentence in <sup>/<em>/<strong> (exempt) and one link alone in an <em> (not)
//   /covered-long     400 paragraphs, a link at the end under a fixed bar; /covered-huge: 10100 paragraphs, more than covered walks
//   /stable-nav       the trigger is a link to another page; /stable-reload: a button that reloads the page
//   /stable-sheet     a scrolling fixed sheet, its trigger below the visible part: scrolling it into view is not a move
//   /first-view-far   the CTA lies 3000 px down the page
//   /edges-right-plain-ok  two blocks without background or border whose right edges differ by 3 px: nothing to see
//   /row-align-overlap  two texts that overlap
//   /row-align-many   30 boxes in one wrapping row, 2 px apart
//   /row-align-table  a table row with a cell 3 px off its neighbours
//   /row-align-rowspan, /row-align-span-cell, /row-align-lines  cells that span rows or are centred beside taller ones: nothing to find
//   /tap-size-fixed-pair, /tap-size-fixed-apart  a fixed chat button 56 px over a button of a fixed bar (apart: 80 px higher, no overlap)
//   /tap-size-bar     a fixed bar with two links over page links: the bar is over the page by design (`covered`), no overlap of tap areas
//   /tap-size-clip-<auto|scroll|hidden|clip>  a 120 px box of three 48 px links over four more: what the box cuts off overlaps nothing
//   /tap-size-clip-border  four boxes with a 10 px border, a button poking 10 px into the border, a link over that strip: the box cuts at its padding box
//   /tap-size-clip-edge  a box cuts the overlap with the link under it down to 1 px (no overlap) and, further down, to 2 px (one)
//   /tap-size-nested  a link around a role=button span, a role=button label over its checkbox: no overlap
//   /tap-size-cards   two overflow:hidden cards 40 px over each other, a button in each; /tap-size-own-clip  two buttons 10 px over each other, one with a 6 px border and its own overflow:hidden
//   /tap-size-containing, /tap-size-fixed-clip  boxes that overflow:hidden does not clip (absolute outside it, fixed, in a fixed sheet): their overlaps are found
//   /tap-size-edge    four pairs of buttons: 1 px and 2 px over each other and side by side
//   /tap-size-100     exactly 100 small buttons
//   /first-view-edge  the CTA ends at 2360 px: the picture just fits 2400 px
//   /stable-many, /text-fit-many, /edges-many, /row-align-forty, /row-align-tall, /first-view-many  more than any earlier cap: 13 movers of 2000 boxes, 60 cut texts, 55 pairs, 40 boxes in a row, a 10-line box, 8 CTAs
//   /covered-100, /covered-101, /covered-controls-40, /covered-controls-30, /covered-views  content and controls at the limits of `covered`; views: 150 paragraphs on a phone, 400 on a wide screen
import { createServer } from "node:http";

const page = (body, style = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Geometry fixture</title><style>*{box-sizing:border-box}body{margin:0;font:16px/1.4 Arial,sans-serif;color:#111;background:#fff}${style}</style></head><body>${body}</body></html>`;

const filler = (n, text = "A line of ordinary content.") => Array.from({ length: n }, () => `<p>${text}</p>`).join("");

/** `n` links of 48 px, each a block of the page (ids `${id}0`…). */
const links = (n, id = "p") => Array.from({ length: n }, (_, i) => `<a href="#${id}${i}" style="display:block;height:48px;line-height:48px">Link ${id}${i}</a>`).join("");
const chatOver = (bottom) => `<div style="position:fixed;right:16px;bottom:${bottom}px"><button id="chatbtn" style="width:56px;height:56px">Chat</button></div>`;
const bar = `<div style="position:fixed;left:0;right:0;bottom:0;height:72px;background:#222;padding:12px"><button id="buy" style="position:absolute;right:40px;top:12px;width:120px;height:48px">Buy</button></div>`;
const coveredBar = `<div style="position:fixed;bottom:0;left:0;right:0;height:72px;background:#222"></div>`;
const coveredPage = (paragraphs, anchors) =>
  page(`<main>${filler(paragraphs - 1)}<p id="last">The last paragraph.</p>${Array.from({ length: anchors }, (_, i) => `<a id="l${i}" href="#e${i}">Link ${i}</a>`).join("")}</main>${coveredBar}`);

const PAGES = {
  "/first-view-bad": page(
    `<header style="height:60px;padding:16px;background:#123;color:#fff">Shop</header>
     <section class="hero" style="min-height:700px;padding:24px;background:#eef"><h1>Welcome</h1><a class="cta" href="#buy" style="display:inline-block;margin-top:600px;padding:12px 24px;background:#06c;color:#fff">Buy now</a></section>`,
  ),
  "/first-view-ok": page(
    `<header style="height:60px;padding:16px;background:#123;color:#fff">Shop</header>
     <section class="hero" style="padding:24px"><h1 style="margin:0 0 16px">Welcome</h1><a class="cta" href="#buy" style="display:inline-block;padding:12px 24px;background:#06c;color:#fff">Buy now</a></section>${filler(30)}`,
  ),
  "/covered-bad": page(
    `<header style="position:fixed;top:0;left:0;right:0;height:64px;background:#123;color:#fff;padding:20px 16px;z-index:5">Fixed header</header>
     <main><p id="first">The first paragraph starts under the header and can never be scrolled out from under it.</p>${filler(40)}<a id="last" href="#end">Last link</a></main>
     <div style="position:fixed;bottom:0;left:0;right:0;height:72px;background:#222;color:#fff;padding:24px 16px;z-index:5">Fixed bar</div>`,
    "main{padding:8px 16px 0}",
  ),
  "/covered-ok": page(
    `<header style="position:fixed;top:0;left:0;right:0;height:64px;background:#123;color:#fff;padding:20px 16px;z-index:5">Fixed header</header>
     <main><p id="first">The first paragraph starts below the header.</p>${filler(40)}<a id="last" href="#end">Last link</a></main>
     <div style="position:fixed;bottom:0;left:0;right:0;height:72px;background:#222;color:#fff;padding:24px 16px;z-index:5">Fixed bar</div>`,
    "html{scroll-padding:72px 0}main{padding:72px 16px 88px}",
  ),
  "/covered-focus-bad": page(
    `<main>${filler(30)}<a id="deep" href="#deep" style="display:block;margin:16px 0">A link far down the page</a>${filler(30)}</main>
     <div style="position:fixed;bottom:0;left:0;right:0;height:72px;background:#222;color:#fff;padding:24px 16px;z-index:5">Fixed bar</div>`,
    "main{padding:8px 16px 96px}",
  ),
  "/covered-focus-ok": page(
    `<main>${filler(30)}<a id="deep" href="#deep" style="display:block;margin:16px 0">A link far down the page</a>${filler(30)}</main>
     <div style="position:fixed;bottom:0;left:0;right:0;height:72px;background:#222;color:#fff;padding:24px 16px;z-index:5">Fixed bar</div>`,
    "html{scroll-padding-bottom:88px}main{padding:8px 16px 96px}",
  ),
  "/stable-hover-bad": page(
    `<div style="padding:24px"><a class="menu" href="#" style="display:block">Menu<span class="tip">A tip that opens in the flow</span></a><p id="after">Content <b>after</b> the menu.</p></div>`,
    ".tip{display:none;height:60px}.menu:hover .tip{display:block}",
  ),
  "/text-fit-sweep": page(
    `<div class="chip" style="width:30vw;overflow:hidden;white-space:nowrap;background:#eef;padding:4px">Extended warranty</div>`,
    "body{padding:16px}",
  ),
  "/stable-centered-ok": page(
    `<div style="text-align:center;padding:24px"><button id="save" style="padding:8px 16px">Save</button></div><p>Below the row.</p>`,
  ).replace("</body>", `<script>document.getElementById('save').onclick = (e) => { e.target.textContent = 'Saving, please wait…'; };</script></body>`),
  "/edges-right-bad": page(
    `<section class="card" style="background:#eef;padding:12px;margin-bottom:8px">First card</section>
     <section class="card" id="second" style="background:#eef;padding:12px;margin-bottom:8px;margin-right:3px">Second card</section>`,
    "body{padding:16px}",
  ),
  "/edges-center-ok": page(
    `<div style="text-align:center"><section style="background:#eef;padding:12px;margin:0 auto 8px;width:300px">First card</section>
     <section style="background:#eef;padding:12px;margin:0 auto;width:297px">Second card</section></div>`,
    "body{padding:16px}",
  ),
  "/text-fit-clamp-bad": page(
    `<p class="clamp" style="width:200px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">A long description of the listing that needs far more than two lines of room at this width, so it is clamped.</p>
     <div class="box" style="width:200px;height:20px;overflow:hidden;margin-top:16px">A fixed-height box whose second line of text is cut off by the box.</div>`,
    "body{padding:16px}",
  ),
  "/text-fit-clamp-ok": page(
    `<p class="clamp" title="A long description of the listing that needs far more than two lines of room at this width, so it is clamped." style="width:200px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">A long description of the listing that needs far more than two lines of room at this width, so it is clamped.</p>
     <div class="box" style="width:200px;overflow:hidden;margin-top:16px">A box that grows with its text.</div>`,
    "body{padding:16px}",
  ),
  "/tap-size-many": page(
    `${Array.from({ length: 45 }, (_, i) => `<button class="small" style="display:block;width:20px;height:20px;margin:4px 0" aria-label="Item ${i}"></button>`).join("")}
     <div style="display:flex;margin-top:24px"><span>Rooms</span><span style="margin-left:40px;padding-top:1.5px">4.5</span></div>
     <div style="position:relative;height:60px;margin-top:24px"><a id="one" href="#a" style="position:absolute;left:0;top:0;width:120px;height:48px;background:#eef">One</a><a id="two" href="#b" style="position:absolute;left:100px;top:0;width:120px;height:48px;background:#fee">Two</a></div>`,
    "body{padding:16px}",
  ),
  "/covered-modal-ok": page(
    `<header style="position:fixed;top:0;left:0;right:0;height:64px;background:#123;color:#fff;padding:20px 16px;z-index:5">Fixed header</header>
     <main><p id="first">The first paragraph starts under the header.</p>${filler(40)}</main>
     <dialog id="m" style="z-index:9"><p>A modal dialog</p><button>Close</button></dialog>`,
    "main{padding:8px 16px 0}",
  ).replace("</body>", `<script>document.getElementById('m').showModal();</script></body>`),
  "/stable-bad": page(
    `<div class="row"><button id="save" style="padding:8px 16px">Save</button><a id="cancel" href="#" style="margin-left:12px">Cancel</a></div><p>Below the row.</p>`,
    ".row{padding:24px}",
  ).replace("</body>", `<script>document.getElementById('save').onclick = (e) => { e.target.textContent = 'Saving, please wait…'; };</script></body>`),
  "/stable-ok": page(
    `<div class="row"><button id="save" style="padding:8px 16px;width:240px">Save</button><a id="cancel" href="#" style="margin-left:12px">Cancel</a></div><p>Below the row.</p>`,
    ".row{padding:24px}",
  ).replace("</body>", `<script>document.getElementById('save').onclick = (e) => { e.target.textContent = 'Saving, please wait…'; };</script></body>`),
  "/edges-bad": page(
    `<section class="card" style="background:#eef;padding:12px;margin-bottom:8px">First card</section>
     <section class="card" id="second" style="background:#eef;padding:12px;margin-bottom:8px;margin-left:3px">Second card</section>`,
    "body{padding:16px}",
  ),
  "/edges-ok": page(
    `<section class="card" style="background:#eef;padding:12px;margin-bottom:8px">First card</section>
     <section class="card" style="background:#eef;padding:12px;margin-bottom:8px">Second card</section>
     <section class="card" style="background:#eef;padding:12px;margin-left:24px">Indented on purpose</section>`,
    "body{padding:16px}",
  ),
  "/text-fit-bad": page(
    `<div class="chip" style="width:80px;overflow:hidden;white-space:nowrap;background:#eef;padding:4px">Extended warranty</div>
     <div class="name" style="width:120px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;margin:16px 0">A very long listing name that cannot fit</div>
     <button class="btn" style="width:90px;white-space:nowrap;padding:8px">Download the full report</button>`,
    "body{padding:16px}",
  ),
  "/text-fit-ok": page(
    `<div class="chip" style="width:200px;overflow:hidden;white-space:nowrap;background:#eef;padding:4px">Extended warranty</div>
     <div class="name" title="A very long listing name that cannot fit" style="width:120px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;margin:16px 0">A very long listing name that cannot fit</div>
     <button class="btn" style="width:90px;padding:8px">Download the full report</button>`,
    "body{padding:16px}",
  ),
  "/row-align-bad": page(
    `<div class="gap" style="display:flex;margin-bottom:24px"><span>Price</span><span style="margin-left:2px">CHF 1'250'000</span></div>
     <div class="base" style="display:flex;align-items:flex-start"><span>Rooms</span><span style="margin-left:40px;padding-top:3px">4.5</span></div>`,
    "body{padding:16px}",
  ),
  "/row-align-sweep": page(
    `<div style="display:flex"><span>Price</span><span style="margin-left:0.5vw">CHF 1'250'000</span></div>`,
    "body{padding:16px}",
  ),
  "/row-align-ok": page(
    `<div class="gap" style="display:flex;margin-bottom:24px"><span>Price</span><span style="margin-left:16px">CHF 1'250'000</span></div>
     <div class="base" style="display:flex;align-items:flex-start"><span>Rooms</span><span style="margin-left:40px">4.5</span></div>
     <p>Words in <b>one</b> <i>sentence</i> sit close, on purpose.</p>`,
    "body{padding:16px}",
  ),
  "/tap-size-bad": page(
    `<div class="icons"><button class="icon" aria-label="Edit" style="width:28px;height:28px;margin-right:8px"></button><button class="icon" aria-label="Delete" style="width:28px;height:28px"></button></div>
     <div style="position:relative;height:60px;margin-top:24px"><a id="one" href="#a" style="position:absolute;left:0;top:0;width:120px;height:48px;background:#eef">One</a><a id="two" href="#b" style="position:absolute;left:100px;top:0;width:120px;height:48px;background:#fee">Two</a></div>`,
    "body{padding:16px}",
  ),
  "/tap-size-ok": page(
    `<div class="icons"><button class="icon" aria-label="Edit" style="width:48px;height:48px;margin-right:8px"></button><button class="icon" aria-label="Delete" style="width:48px;height:48px"></button></div>
     <button class="reach" aria-label="Close" style="position:relative;width:28px;height:28px;margin:12px 0"></button>
     <label style="display:flex;align-items:center;gap:8px;height:48px"><input type="checkbox" style="margin:0"> Subscribe</label>
     <p>Read the <a href="#terms">terms</a> before you continue with the application.</p>`,
    "body{padding:16px}.reach::after{content:'';position:absolute;inset:-12px}",
  ),
  "/blank": "<!doctype html><title>blank</title>",
  "/tap-size-sheet": page(
    `<main>${Array.from({ length: 14 }, (_, i) => `<a href="#page${i}" style="display:block;height:48px;line-height:48px">Page link ${i}</a>`).join("")}</main>
     <div class="sheet" style="position:fixed;left:0;right:0;bottom:0;height:300px;overflow:auto;background:#eef;padding:16px">${Array.from({ length: 12 }, (_, i) => `<button aria-label="Item ${i}" style="display:block;width:20px;height:20px;margin:0 0 40px"></button>`).join("")}
       <a id="one" href="#a" style="display:block;width:160px;height:48px;background:#fee">One</a><a id="two" href="#b" style="display:block;width:160px;height:48px;margin-top:-20px;background:#efe">Two</a></div>`,
  ),
  "/tap-size-list": page(
    `<div class="list" style="height:120px;overflow:auto;border:1px solid #888">${Array.from({ length: 8 }, (_, i) => `<a href="#row${i}" style="display:block;height:48px;line-height:48px">Row ${i}</a>`).join("")}</div>
     ${Array.from({ length: 4 }, (_, i) => `<a href="#next${i}" style="display:block;height:48px;line-height:48px">Next ${i}</a>`).join("")}`,
  ),
  "/tap-size-late": page(
    `${Array.from({ length: 250 }, (_, i) => `<a href="#a${i}" style="display:block;height:48px;line-height:48px">Link ${i}</a>`).join("")}<button id="late" style="width:20px;height:20px" aria-label="Late"></button>`,
  ),
  "/tap-size-cap": page(
    `${Array.from({ length: 115 }, (_, i) => `<button aria-label="Item ${i}" style="display:block;width:${i < 110 ? 28 : 20}px;height:${i < 110 ? 28 : 20}px;margin:4px 0"></button>`).join("")}
     <div style="position:relative;height:60px;margin-top:24px"><a id="one" href="#a" style="position:absolute;left:0;top:0;width:120px;height:48px;background:#eef">One</a><a id="two" href="#b" style="position:absolute;left:100px;top:0;width:120px;height:48px;background:#fee">Two</a></div>`,
  ),
  "/tap-size-vary": page(`<button id="b" style="width:100px;height:calc(10px + 2vw)" aria-label="Vary"></button>`, "body{padding:16px}"),
  "/tap-size-wrapped": page(
    `<p>The city name is pronounced like this <sup><a href="#r1">[12]</a></sup> and the sentence goes on for a good while, with more <em><a href="#r2">emphasised words</a></em> and <strong><a href="#r3">strong words</a></strong> after that.</p>
     <p>Wrapped twice <strong><em><a href="#r5">deep in the sentence</a></em></strong> and the sentence goes on for a good while longer.</p>
     <p><em><a id="alone" href="#r4">Pricing</a></em></p>`,
    "body{padding:16px}",
  ),
  "/covered-long": page(
    `<main>${filler(400)}<a id="last" href="#end">Last link</a></main>
     <div style="position:fixed;bottom:0;left:0;right:0;height:72px;background:#222;color:#fff;padding:24px 16px;z-index:5">Fixed bar</div>`,
    "main{padding:8px 16px 0}",
  ),
  "/covered-huge": page(
    `<main>${filler(10100)}</main><div style="position:fixed;bottom:0;left:0;right:0;height:72px;background:#222;color:#fff;padding:24px 16px;z-index:5">Fixed bar</div>`,
  ),
  "/stable-nav": page(
    `<div class="row"><a id="go" href="/stable-nav-target" style="padding:8px">Go</a><a id="cancel" href="#" style="margin-left:12px;padding:8px">Cancel</a></div>`,
    ".row{padding:24px}",
  ),
  "/stable-nav-target": page(`<p>Another page</p>`),
  "/stable-reload": page(
    `<div class="row"><button id="go" style="padding:8px">Go</button><a id="cancel" href="#" style="margin-left:12px;padding:8px">Cancel</a></div>`,
    ".row{padding:24px}",
  ).replace("</body>", `<script>document.getElementById('go').onclick = () => location.reload();</script></body>`),
  "/stable-sheet": page(
    `<div class="sheet" style="position:fixed;left:0;right:0;bottom:0;height:200px;overflow:auto;background:#eef;padding:16px">${Array.from({ length: 12 }, (_, i) => `<p>Row ${i}</p>`).join("")}<button id="save" style="padding:8px 16px;width:240px">Save</button></div>`,
  ).replace("</body>", `<script>document.getElementById('save').onclick = (e) => { e.target.textContent = 'Saving…'; };</script></body>`),
  "/first-view-far": page(
    `<header style="height:60px;padding:16px;background:#123;color:#fff">Shop</header><div style="height:3000px"></div><a class="cta" href="#buy" style="display:inline-block;padding:12px 24px;background:#06c;color:#fff">Buy now</a>`,
  ),
  "/edges-right-plain-ok": page(
    `<section class="card" style="padding:12px;margin-bottom:8px">First card</section>
     <section class="card" style="padding:12px;margin-bottom:8px;margin-right:3px">Second card</section>`,
    "body{padding:16px}",
  ),
  "/row-align-overlap": page(
    `<div style="display:flex"><span>Price</span><span style="margin-left:-20px">CHF 1'250'000</span></div>`,
    "body{padding:16px}",
  ),
  "/row-align-many": page(
    `<div style="display:flex;flex-wrap:wrap">${Array.from({ length: 30 }, (_, i) => `<span id="c${i}" style="margin-right:2px">Item ${i}</span>`).join("")}</div>`,
    "body{padding:16px}",
  ),
  "/row-align-table": page(
    `<table style="border-collapse:collapse;width:300px;font-size:14px"><tr><td style="padding:4px">No answer</td><td style="padding:4px">Swiss</td><td style="padding:4px">2%</td><td id="low" style="padding:7px 4px 1px">1%</td></tr></table>`,
  ),
  // A cell spanning two rows, centred, with text on two lines: the rows are not boxes (their merged lines overlapped by 159 px)
  // and the cell is not off the baseline of its neighbours.
  "/row-align-rowspan": page(
    `<table style="border-collapse:collapse;width:420px;font-size:14px"><tr><td style="padding:4px;width:120px">Migration</td><td rowspan="2" style="padding:4px;vertical-align:middle;width:120px">Foreign nationals living in Switzerland</td><td style="padding:4px">2020</td></tr><tr><td style="padding:4px">Born abroad</td><td style="padding:4px">2021</td></tr></table>`,
  ),
  // A spanning cell of one line with more padding on top than its neighbours: same number of lines, placed by its span.
  "/row-align-span-cell": page(
    `<table style="border-collapse:collapse;width:300px;font-size:14px"><tr><td rowspan="2" style="width:70px;padding:9px 4px 0;vertical-align:top">Total</td><td style="padding:4px">Swiss</td></tr><tr><td style="padding:4px">Other</td></tr></table>`,
  ),
  // A two-line cell next to a one-line cell centred in the row: not the same number of lines, placed by its centring.
  "/row-align-lines": page(
    `<table style="border-collapse:collapse;width:300px;font-size:14px;line-height:1.2"><tr><td style="width:70px;padding:4px 4px 0;vertical-align:middle">Other<br>Religion</td><td style="padding:4px;vertical-align:middle">Swiss</td></tr></table>`,
  ),
  // ---- tap-size overlap: the screen at one scroll position, rects cut at what clips them
  // the clip box cuts a relative button too; a fixed header or a sticky nav that comes before the page links in the DOM
  // is covered's business, not a tap overlap
  "/tap-size-relative-clip": page(
    `<div style="overflow:hidden;height:60px"><button id="r1" style="position:relative;display:block;width:100%;height:100px">First</button></div><button id="r2" style="display:block;width:100%;height:48px">Second</button>`,
  ),
  "/tap-size-header-first": page(
    `<header style="position:fixed;left:0;right:0;top:0;height:60px;background:#222;padding:6px"><button id="hb" style="width:120px;height:48px">Menu</button></header><main>${links(8)}</main>`,
  ),
  "/tap-size-sticky-first": page(
    `<nav style="position:sticky;top:0;height:60px;margin-bottom:-30px;background:#eee"><a id="s1" href="#s1" style="display:inline-block;width:120px;height:48px;line-height:48px">Nav</a></nav><main>${links(6)}</main>`,
  ),
  "/tap-size-fixed-pair": page(`<main>${links(10)}</main>${chatOver(16)}${bar}`),
  "/tap-size-fixed-apart": page(`<main>${links(10)}</main>${chatOver(96)}${bar}`),
  "/tap-size-bar": page(
    `<main>${links(14)}</main>
     <div style="position:fixed;left:0;right:0;bottom:0;height:80px;background:#222;padding:8px"><a id="x1" href="#x1" style="display:inline-block;width:150px;height:48px;line-height:48px;background:#fff">Bar one</a> <a id="x2" href="#x2" style="display:inline-block;width:150px;height:48px;line-height:48px;background:#fff">Bar two</a></div>`,
  ),
  ...Object.fromEntries(
    ["auto", "scroll", "hidden", "clip"].map((overflow) => [
      `/tap-size-clip-${overflow}`,
      page(`<div id="box" style="height:120px;overflow:${overflow}">${links(3)}</div>${links(4, "next")}`),
    ]),
  ),
  // A box clips at its padding box: a button poking 10 px into the border of its 10 px border box shows no more than the
  // padding box, so a link lying over that border strip is not under it. One box per side.
  "/tap-size-clip-border": page(
    [
      ["left", "left:-10px;top:20px", "left:0;top:90px", false],
      ["right", "right:-10px;top:20px", "left:210px;top:90px", true],
      ["top", "left:30px;top:-10px", "left:70px;top:20px", false],
      ["bottom", "left:30px;bottom:-10px", "left:70px;top:150px", true],
    ]
      .map(([side, button, link, linkFirst]) => {
        const box = `<div style="position:absolute;left:40px;top:60px;width:180px;height:100px;border:10px solid #888;overflow:hidden"><button id="in-${side}" style="position:absolute;${button};width:100px;height:48px">In ${side}</button></div>`;
        const over = `<a id="over-${side}" href="#${side}" style="position:absolute;${link};width:50px;height:50px;background:#fee">${side}</a>`;
        return `<div style="position:relative;width:260px;height:220px">${linkFirst ? over + box : box + over}</div>`;
      })
      .join(""),
  ),
  // A box that cuts the overlap down to 1 px (the link under it starts 1 px inside) and one down to 2 px.
  "/tap-size-clip-edge": page(
    `<div style="height:120px;overflow:hidden">${links(3, "a")}</div><a id="one" href="#one" style="display:block;height:48px;margin-top:-1px">One</a>
     <div style="height:120px;overflow:hidden">${links(3, "b")}</div><a id="two" href="#two" style="display:block;height:48px;margin-top:-2px">Two</a>`,
  ),
  // A target in a target (a link around a button) and a label that is a target of its own over its field: one tap area each.
  "/tap-size-nested": page(
    `<a id="outer" href="#outer" style="display:block;height:48px"><span id="inner" role="button" style="display:block;height:48px">Inside</span></a>
     <div style="position:relative;height:60px"><input id="check" type="checkbox" style="position:absolute;left:0;top:0;width:48px;height:48px"><label id="lbl" for="check" role="button" style="position:absolute;left:0;top:0;width:120px;height:48px">Label</label></div>`,
  ),
  "/tap-size-cards": page(
    `<div class="card" style="overflow:hidden;height:80px;position:relative;background:#eef"><button id="b1" style="width:100%;height:80px">First card</button></div>
     <div class="card" style="overflow:hidden;height:80px;position:relative;margin-top:-40px;background:#fee"><button id="b2" style="width:100%;height:80px">Second card</button></div>`,
  ),
  // A button that clips its own content: its own border is not a clip box for itself.
  "/tap-size-own-clip": page(
    `<div style="position:relative;height:60px"><button id="e1" style="position:absolute;left:0;top:0;width:140px;height:48px;border:6px solid #888;overflow:hidden;white-space:nowrap">A very long label that is cut</button><button id="e2" style="position:absolute;left:130px;top:0;width:140px;height:48px">Two</button></div>`,
  ),
  // #far sits in an absolute box whose containing block is `.outer`: the overflow:hidden box between does not clip it.
  "/tap-size-containing": page(
    `<div class="outer" style="position:relative;height:130px"><div style="overflow:hidden;width:200px;height:40px"><div style="position:absolute;left:0;top:60px"><button id="far" style="width:120px;height:48px">Far</button></div></div>
     <button id="near" style="position:absolute;left:100px;top:50px;width:120px;height:48px">Near</button></div>`,
  ),
  // A fixed box is not clipped by what it sits in (#fx), nor is what sits in a fixed sheet (#s1, #s2).
  "/tap-size-fixed-clip": page(
    `<div style="overflow:hidden;width:100px;height:20px"><button id="fx" style="position:fixed;left:0;top:100px;width:120px;height:48px">One</button></div>
     <button id="fy" style="position:fixed;left:100px;top:120px;width:120px;height:48px">Two</button>
     <div style="overflow:hidden;width:100px;height:20px"><div style="position:fixed;left:0;top:300px;width:300px;height:200px"><button id="s1" style="display:block;width:120px;height:48px">A</button><button id="s2" style="display:block;width:120px;height:48px;margin:-20px 0 0 60px">B</button></div></div>`,
  ),
  // Four pairs of 48 px buttons: 1 px and 2 px over each other, 1 px and 2 px side by side. From 2 px it is an overlap.
  "/tap-size-edge": page(
    `<div style="position:relative;height:300px">${[
      ["a1", 0, 0],
      ["a2", 0, 47],
      ["c1", 0, 100],
      ["c2", 0, 146],
      ["e1", 100, 0],
      ["e2", 179, 0],
      ["g1", 100, 100],
      ["g2", 178, 100],
    ]
      .map(([id, left, top]) => `<button id="${id}" style="position:absolute;left:${left}px;top:${top}px;width:80px;height:48px">${id}</button>`)
      .join("")}</div>`,
  ),
  "/tap-size-100": page(Array.from({ length: 100 }, (_, i) => `<button aria-label="Item ${i}" style="display:block;width:28px;height:28px;margin:4px 0"></button>`).join("")),
  // ---- what a page can hold before a check would have to stop: nothing is cut off silently
  "/stable-many": page(
    `<button id="go" style="height:48px;padding:0 16px">Go</button>${Array.from({ length: 2000 }, (_, i) => `<div id="m${i}" style="height:20px;font-size:12px">row ${i}</div>`).join("")}
     <script>document.getElementById('go').onclick = () => { for (const i of [100,101,102,103,104,105,106,107,108,109,110,111,1800]) document.getElementById('m' + i).style.transform = 'translateX(14px)'; };</script>`,
  ),
  "/text-fit-many": page(Array.from({ length: 60 }, (_, i) => `<div id="t${i}" style="width:60px;overflow:hidden;white-space:nowrap;font-size:14px">Text number ${i} is cut</div>`).join("")),
  "/edges-many": page(
    Array.from({ length: 56 }, (_, i) => `<div id="e${i}" style="height:24px;margin-left:${i % 2 ? 2 : 0}px;background:#eef;border:1px solid #99a;margin-bottom:6px">block ${i}</div>`).join(""),
    "body{padding:16px 40px}",
  ),
  "/row-align-forty": page(
    `<div style="display:flex;white-space:nowrap;font-size:11px">${Array.from({ length: 40 }, (_, i) => `<span id="k${i}" style="margin-right:${i === 35 ? 1 : 12}px">k${String(i).padStart(2, "0")}</span>`).join("")}</div>`,
  ),
  // The right text sits beside the tenth line of the left one, 2 px away (second row: beside its first line): only a check that reads every line sees it.
  "/row-align-tall": page(
    `<div style="display:flex;align-items:flex-end;font-size:14px;line-height:20px"><div id="tall">${Array.from({ length: 10 }, () => "Word").join("<br>")}</div><div id="side" style="margin-left:2px">Aside</div></div>
     <div style="display:flex;align-items:flex-start;font-size:14px;line-height:20px;margin-top:24px"><div id="tall2">${Array.from({ length: 10 }, () => "Word").join("<br>")}</div><div id="side2" style="margin-left:2px">Aside</div></div>`,
  ),
  // The CTA ends at 2360 px: with the 40 px below it the picture is exactly the 2400 px it can show, nothing to say.
  "/first-view-edge": page(`<div style="height:2312px"></div><a class="cta" href="#buy" style="display:block;height:48px">Buy now</a><div style="height:200px"></div>`),
  "/first-view-many": page(
    `${Array.from({ length: 6 }, (_, i) => `<a class="cta" id="c${i + 1}" href="#c${i}" style="display:block;height:30px">cta ${i + 1}</a>`).join("")}<div style="height:1400px"></div><a class="cta" id="c7" href="#c7" style="display:block;height:30px">cta 7</a><a class="cta" id="c8" href="#c8" style="display:block;height:30px">cta 8</a>`,
  ),
  // `covered` walks content elements and, of those, controls (a third as many): `n` paragraphs + `m` links under a fixed bar
  "/covered-100": coveredPage(100, 0),
  "/covered-101": coveredPage(101, 0),
  "/covered-controls-40": coveredPage(20, 40),
  "/covered-controls-30": coveredPage(20, 30),
  "/covered-views": page(
    `<main>${filler(150)}${Array.from({ length: 250 }, () => `<p class="more">More on a wide screen.</p>`).join("")}</main>${coveredBar}`,
    "@media (max-width:600px){.more{display:none}}",
  ),
};

const edgesShift = (px) =>
  page(
    `<section class="card" style="background:#eef;padding:12px;margin-bottom:8px">First card</section>
     <section class="card" id="second" style="background:#eef;padding:12px;margin-bottom:8px;margin-left:${px}px">Second card</section>`,
    "body{padding:16px}",
  );

/** Starts the fixture on a free port. `setShift(n)` moves the second card of /edges-shift. */
export async function startGeometryApp() {
  let shift = 0;
  const server = createServer((req, res) => {
    const route = new URL(req.url, "http://x").pathname;
    const html = route === "/edges-shift" ? edgesShift(shift) : PAGES[route];
    if (!html) {
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
    setShift: (px) => {
      shift = px;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
