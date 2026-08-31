// Intentional-defect fixture for the Visual QA vertical slice.
import { createServer } from "node:http";

const port = Number(process.env.PORT || 4173);
const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Visual QA fixture</title>
<style>
*{box-sizing:border-box}body{margin:0;font:16px system-ui,sans-serif;color:#17202a;background:#f8fafc}header{padding:22px 5vw;background:#12324a;color:#fff}main{max-width:900px;margin:auto;padding:24px}.card{background:#fff;padding:20px;border-radius:12px;margin:14px 0;box-shadow:0 1px 4px #0002}.nav{display:flex;gap:18px}.tiny{width:12px;height:12px;padding:0;border:0;background:#e11}.overflow{width:1100px}.error{color:#a00}dialog{border:0;border-radius:10px;box-shadow:0 3px 20px #0005}@media(max-width:500px){main{padding:12px}.overflow{width:700px}.nav{gap:32px;white-space:nowrap}}
</style></head>
<body><header><h1>Visual QA fixture</h1><nav class="nav"><a href="/home">Home</a><a href="/missing">Broken navigation</a><button id="open">Open details</button></nav></header>
<main><section class="card"><h2>Search catalogue</h2><label for="query">Query</label><input id="query" type="text" required placeholder="Search"><button id="search">Search</button><p id="result">Results are ready.</p></section>
<section class="card"><h2>Actions</h2><button id="dead">Apply filter</button><button id="crash">Load data</button><button id="save">Save draft</button><button id="danger">Delete account</button><button class="tiny"></button></section>
<section class="card overflow"><h2>Responsive defect</h2><p>This intentionally over-wide panel causes horizontal overflow on mobile.</p></section>
<section class="card"><h2>TODO: Write this section</h2><p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Placeholder text lives here until the copy is written.</p></section>
<dialog id="details"><h2>Details</h2><p>Focusable modal content.</p><button id="close">Close</button></dialog>
<script>
const result=document.querySelector('#result');
document.querySelector('#open').onclick=()=>details.showModal();
document.querySelector('#close').onclick=()=>details.close();
document.querySelector('#search').onclick=()=>{result.textContent=query.value?'Results for '+query.value:'Please enter a query';};
document.querySelector('#crash').onclick=()=>{throw new Error('seeded fixture runtime failure');};
document.querySelector('#save').onclick=()=>{fetch('/api/fail').then(()=>{});};
// dead button intentionally has no handler; broken link intentionally returns 404.
</script></main></body></html>`;

createServer((req, res) => {
  if (req.url === "/api/fail") {
    res.writeHead(500);
    return res.end("fixture failure");
  }
  if (req.url === "/missing") {
    res.writeHead(404);
    return res.end("not found");
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}).listen(port, "127.0.0.1", () =>
  console.log(`fixture http://127.0.0.1:${port}`),
);
