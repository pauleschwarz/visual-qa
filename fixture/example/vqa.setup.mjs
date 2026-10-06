// Runs before every state and journey. `page` is a fresh Playwright page;
// ctx is { baseUrl, state, viewport, locale }.
export async function setup(page, ctx) {
  await page.context().addCookies([
    { name: "sid", value: "demo", url: ctx.baseUrl },
  ]);
}
