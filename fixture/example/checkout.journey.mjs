// step(name, async (page, ctx) => …) acts; check(name, async (page, ctx) => …)
// returns true, or false / a string saying why not. The first red one stops
// the journey with a stop image.
export default async function ({ step, check }) {
  await step("open checkout", (page, ctx) =>
    page.goto(new URL("/checkout", ctx.baseUrl).href),
  );
  await step("continue", (page) =>
    page.getByRole("button", { name: "Continue" }).click(),
  );
  await check("second step is shown", (page) =>
    page.getByRole("heading", { name: /step 2 of 2/ }).isVisible(),
  );
  await step("place order", (page) =>
    page.getByRole("button", { name: "Place order" }).click(),
  );
  await check("order is confirmed", (page) =>
    page.getByRole("heading", { name: "Order placed" }).isVisible(),
  );
}
