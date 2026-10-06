// A small sign-in app for the states / journeys docs and tests: cookie
// session, a list loaded from an API (with and without a good error state)
// and a two-step checkout.
//
//   PORT=4174 node fixture/app-server.mjs
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const PAGE = (title, body, script = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="Fixture app for visual-qa states and journeys.">
<style>
body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#17202a;background:#fff}
header,main{max-width:720px;margin:0 auto;padding:16px}
nav{display:flex;gap:8px;flex-wrap:wrap}
a,button{min-height:44px;display:inline-flex;align-items:center;padding:0 14px;font:inherit}
button{background:#12324a;color:#fff;border:0;border-radius:6px;cursor:pointer}
a{color:#0b4f8a}
input{min-height:44px;font:inherit;padding:0 10px;display:block;margin:4px 0 12px;width:100%;max-width:320px;box-sizing:border-box}
[role=alert]{color:#8a1c1c}
</style></head><body>
<header><nav aria-label="Main"><a href="/">Home</a><a href="/account">Account</a><a href="/orders">Orders</a><a href="/checkout">Checkout</a></nav></header>
<main>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;

const ORDERS_SCRIPT = (onError, query = "") => `
const box=document.querySelector('#orders');
fetch('/api/orders${query}').then(r=>{if(!r.ok)throw new Error(r.status);return r.json()})
.then(list=>{box.innerHTML='<ul>'+list.map(o=>'<li>'+o+'</li>').join('')+'</ul>'})
.catch(()=>{${onError}});`;

const RETRY = `box.innerHTML='<p role="alert">Could not load your orders.</p><button type="button" onclick="location.reload()">Try again</button>'`;
const REASON_ONLY = `box.innerHTML='<p role="alert">Could not load your orders.</p>'`;
const SILENT = `box.innerHTML=''`;

const CHECKOUT_SCRIPT = `
const view=document.querySelector('#view');
const step1=()=>{view.innerHTML='<h1>Checkout, step 1 of 2</h1><p>Plan: Standard</p><button type="button" id="next">Continue</button>';document.querySelector('#next').onclick=step2};
const step2=()=>{view.innerHTML='<h1>Checkout, step 2 of 2</h1><p>Total: 10 EUR</p><button type="button" id="pay">Place order</button>';document.querySelector('#pay').onclick=done};
const done=()=>{view.innerHTML='<h1>Order placed</h1><p role="status">Thank you.</p>'};
step1();`;

const LOGIN_FORM = `<h1>Sign in</h1>
<form method="post" action="/login">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button></form>`;

// Pages with seeded defects, so tests can prove the usual checks run in states and journey steps.
const DEFECTS = `<h1>Defects</h1>
<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40">
<div style="width:2000px;height:20px;background:#eee">Too wide for the screen</div>
<p style="color:#bbb">Low contrast text</p>
<div style="position:fixed;top:0;left:0;width:200px;height:60px;background:#12324a;color:#fff">Bar one</div>
<div style="position:fixed;top:30px;left:0;width:200px;height:60px;background:#0b4f8a;color:#fff">Bar two</div>`;
// Normal content that mentions errors, with links, and an API call whose failure it swallows.
const DOCS = `<h1>Docs</h1><p>Error handling is covered in chapter 3. We could not be happier.</p>
<p><a href="/checkout">Chapter 3</a></p>
<script>fetch('/api/orders').catch(()=>{})</script>`;
const DRAFT = "<h1>Lorem ipsum dolor sit amet</h1><p>consectetur adipiscing elit.</p>";

const signedIn = (req) => /(?:^|;\s*)sid=demo(?:;|$)/.test(req.headers.cookie ?? "");

export function createAppServer() {
  return createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const html = (body, status = 200) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };
    const redirect = (to, headers = {}) => {
      res.writeHead(303, { location: to, ...headers });
      res.end();
    };
    if (path === "/api/orders") {
      if (!signedIn(req)) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end('{"error":"sign in"}');
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('["Order 1001","Order 1002"]');
    }
    if (path === "/login" && req.method === "POST") {
      req.resume();
      return redirect("/account", { "set-cookie": "sid=demo; Path=/; HttpOnly" });
    }
    if (path === "/login")
      return signedIn(req) ? redirect("/account") : html(PAGE("Sign in", LOGIN_FORM));
    if (path === "/account")
      return signedIn(req)
        ? html(PAGE("Account", "<h1>Welcome back</h1><p>Signed in as Sam.</p>"))
        : redirect("/login");
    const orders = {
      "/orders": RETRY,
      "/orders-reason-only": REASON_ONLY,
      "/orders-silent": SILENT,
      "/orders-token": RETRY,
    }[path];
    if (orders !== undefined)
      return html(
        PAGE(
          "Orders",
          '<h1>Your orders</h1><div id="orders">Loading…</div>',
          ORDERS_SCRIPT(orders, path === "/orders-token" ? "?token=abc123&page=1" : ""),
        ),
      );
    if (path === "/defects") return html(PAGE("Defects", DEFECTS));
    if (path === "/docs") return html(PAGE("Docs", DOCS));
    if (path === "/draft") return html(PAGE("Draft", DRAFT));
    if (path === "/checkout")
      return html(PAGE("Checkout", '<div id="view"></div>', CHECKOUT_SCRIPT));
    if (path === "/") return html(PAGE("Shop", "<h1>Shop</h1><p>Welcome to the shop.</p>"));
    return html(PAGE("Not found", "<h1>Not found</h1>"), 404);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT || 4174);
  createAppServer().listen(port, "127.0.0.1", () =>
    console.log(`app fixture http://127.0.0.1:${port}`),
  );
}
