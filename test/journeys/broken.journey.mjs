export default async function ({ step, check }) {
  await step("open checkout", (page, ctx) =>
    page.goto(new URL("/checkout", ctx.baseUrl).href),
  );
  await check("receipt is shown", (page) =>
    page.getByText("Receipt").isVisible(),
  );
  await step("never reached", (page) => page.getByText("nope").click({ timeout: 500 }));
}
