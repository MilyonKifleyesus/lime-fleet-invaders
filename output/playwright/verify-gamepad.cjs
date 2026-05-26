const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const baseUrl = "http://127.0.0.1:5176/";
const out = path.resolve("output/playwright");
const logs = [];
const failures = [];
const checks = [];

function assert(value, message) {
  if (!value) throw new Error(message);
  checks.push(message);
}

async function installGamepad(page) {
  await page.addInitScript(() => {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
    const pad = {
      axes: [0, 0, 0, 0],
      buttons,
      connected: true,
      id: "Verification Standard Gamepad",
      index: 0,
      mapping: "standard",
      timestamp: 0,
    };
    window.__mockGamepad = pad;
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => [pad],
    });
  });
}

async function animationFrames(frame, count = 2) {
  await frame.evaluate((frames) => new Promise((resolve) => {
    function step() {
      frames -= 1;
      if (frames <= 0) resolve();
      else requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }), count);
}

async function tap(frame, button) {
  await frame.evaluate((index) => {
    const target = window.__mockGamepad.buttons[index];
    target.pressed = true;
    target.touched = true;
    target.value = 1;
    window.__mockGamepad.timestamp++;
  }, button);
  await animationFrames(frame);
  await frame.evaluate((index) => {
    const target = window.__mockGamepad.buttons[index];
    target.pressed = false;
    target.touched = false;
    target.value = 0;
    window.__mockGamepad.timestamp++;
  }, button);
  await animationFrames(frame);
}

async function axis(frame, x, y = 0, duration = 90) {
  await frame.evaluate(({ x, y }) => {
    window.__mockGamepad.axes[0] = x;
    window.__mockGamepad.axes[1] = y;
    window.__mockGamepad.timestamp++;
  }, { x, y });
  await animationFrames(frame, Math.max(2, Math.ceil(duration / 35)));
  await frame.evaluate(() => {
    window.__mockGamepad.axes[0] = 0;
    window.__mockGamepad.axes[1] = 0;
    window.__mockGamepad.timestamp++;
  });
  await animationFrames(frame);
}

async function gameState(frame, expression) {
  return frame.evaluate((source) => window.eval(source), expression);
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
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
    if (["error", "warning"].includes(message.type())) logs.push(`${message.type()}: ${message.text()}`);
  });
  page.on("requestfailed", (request) => failures.push(`${request.url()} ${request.failure()?.errorText || ""}`));
  await installGamepad(page);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const frame = page.frame({ url: /game\.html/ });
  assert(frame, "game iframe loaded");
  await page.waitForTimeout(200);
  assert(await frame.locator("#controllerStatus.visible").isVisible(), "connected controller status is shown");
  await tap(frame, 0);
  assert(await gameState(frame, "gs===STATE.MODE_SELECT"), "A opens game mode selection");
  await axis(frame, 1);
  await tap(frame, 0);
  assert(await frame.locator("#tournamentOverlay.visible").isVisible(), "A chooses tournament mode");
  assert(await frame.locator("#controllerNamePad.visible").isVisible(), "controller name pad is shown");
  await tap(frame, 0);
  await tap(frame, 0);
  await axis(frame, 1);
  await tap(frame, 0);
  await tap(frame, 2);
  assert(await frame.locator("#playerList li").count() === 1, "X adds a controller-entered player");
  await axis(frame, -1);
  await tap(frame, 0);
  await tap(frame, 2);
  assert(await frame.locator("#playerList li").count() === 2, "controller setup accepts a second player");
  await page.screenshot({ path: path.join(out, "verification-desktop.png"), fullPage: true });
  await tap(frame, 9);
  assert(await gameState(frame, "gs===STATE.PLAYER_INTRO"), "Start begins a valid tournament");
  await tap(frame, 0);
  await tap(frame, 0);
  assert(await gameState(frame, "gs===STATE.PLAYING"), "A proceeds into gameplay");
  const initialX = await gameState(frame, "player.x");
  await axis(frame, 1, 0, 250);
  assert(await gameState(frame, "player.x") > initialX, "left stick moves the bus");
  await tap(frame, 0);
  assert(await gameState(frame, "playerBullets.length>0"), "A fires during gameplay");
  await tap(frame, 9);
  assert(await gameState(frame, "gs===STATE.PAUSED"), "Start pauses gameplay");
  await page.screenshot({ path: path.join(out, "verification-desktop-paused.png"), fullPage: true });
  await tap(frame, 0);
  assert(await gameState(frame, "gs===STATE.PLAYING"), "A resumes paused gameplay");
  const video = await page.video().path();
  await desktop.close();
  fs.copyFileSync(video, path.join(out, "verification-video.webm"));

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobilePage = await mobile.newPage();
  mobilePage.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) logs.push(`mobile ${message.type()}: ${message.text()}`);
  });
  mobilePage.on("requestfailed", (request) => failures.push(`mobile ${request.url()} ${request.failure()?.errorText || ""}`));
  await installGamepad(mobilePage);
  await mobilePage.goto(baseUrl, { waitUntil: "networkidle" });
  const mobileFrame = mobilePage.frame({ url: /game\.html/ });
  await tap(mobileFrame, 0);
  await axis(mobileFrame, 1);
  await tap(mobileFrame, 0);
  assert(await mobileFrame.locator("#controllerNamePad.visible").isVisible(), "controller setup is available on mobile viewport");
  await mobilePage.screenshot({ path: path.join(out, "verification-mobile.png"), fullPage: true });
  await mobile.close();
  await browser.close();

  fs.writeFileSync(path.join(out, "verification-report.json"), JSON.stringify({ checks, logs, failures }, null, 2));
  const errors = logs.filter((entry) => entry.includes("error:"));
  if (errors.length || failures.length) throw new Error(`Browser reported failures: ${JSON.stringify({ errors, failures })}`);
  console.log(checks.join("\n"));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
