export default async function ({ step, check }) {
  await step("open sign-in", (page, ctx) =>
    page.goto(new URL("/login", ctx.baseUrl).href),
  );
  await step("fill and submit", async (page) => {
    await page.getByLabel("Email").fill("sam@example.com");
    await page.getByLabel("Password").fill("not-a-real-password");
    await page.getByRole("button", { name: "Sign in" }).click();
  });
  await check("lands in the account", (page) =>
    page.getByRole("heading", { name: "Welcome back" }).isVisible(),
  );
}
