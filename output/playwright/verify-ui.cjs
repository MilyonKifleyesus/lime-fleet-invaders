const fs = require("fs");
const { chromium } = require("playwright");

(async () => {
  const out = "output/playwright";
  const logs = [];
  const failures = [];
  const browser = await chromium.launch({
    headless: true,
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  });

  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: out, size: { width: 1440, height: 900 } },
  });
  const page = await desktop.newPage();
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      logs.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("requestfailed", (request) => {
    failures.push(`${request.url()} ${request.failure()?.errorText || ""}`);
  });

  await page.goto("http://127.0.0.1:5175/", { waitUntil: "networkidle" });
  const gameFrame = page.frame({ url: /game\.html/ });
  await gameFrame.evaluate(() => window.openTournamentSetup());
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/verification-desktop.png`, fullPage: true });
  await gameFrame.locator("#playerNameInput").fill("ERIK");
  await page.waitForTimeout(1000);
  await gameFrame.locator("#playerNameInput").press("Enter");
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/verification-desktop-after-type.png`, fullPage: true });
  await desktop.close();

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const mobilePage = await mobile.newPage();
  mobilePage.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      logs.push(`mobile ${message.type()}: ${message.text()}`);
    }
  });
  mobilePage.on("requestfailed", (request) => {
    failures.push(`mobile ${request.url()} ${request.failure()?.errorText || ""}`);
  });

  await mobilePage.goto("http://127.0.0.1:5175/", { waitUntil: "networkidle" });
  const mobileGameFrame = mobilePage.frame({ url: /game\.html/ });
  await mobileGameFrame.evaluate(() => window.openTournamentSetup());
  await mobilePage.waitForTimeout(500);
  await mobilePage.screenshot({ path: `${out}/verification-mobile.png`, fullPage: true });
  await mobile.close();

  await browser.close();

  const videos = fs.readdirSync(out).filter((file) => file.endsWith(".webm"));
  if (videos.length) {
    fs.copyFileSync(`${out}/${videos[videos.length - 1]}`, `${out}/verification-video.webm`);
  }
  fs.writeFileSync(
    `${out}/verification-report.json`,
    JSON.stringify({ logs, failures, videos }, null, 2),
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
