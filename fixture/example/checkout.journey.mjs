// step(name, async (page, ctx) => …) acts; check(name, async (page, ctx) => …)
// returns true, or false / a string saying why not. The first red one stops
// the journey with a stop image.
// page.goto("/path") resolves against the --url under test.
export default async function ({ step, check }) {
  await step("open checkout", (page) => page.goto("/checkout"));
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
