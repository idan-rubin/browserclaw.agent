import type { CrawlPage } from 'browserclaw';
import { getCdpBaseUrl, getTargetId, activateCdpTarget } from './cdp-utils.js';
import { logger } from '../logger.js';

/**
 * Handles reCAPTCHA v2, hCaptcha, and Cloudflare Turnstile checkbox challenges.
 * These live in cross-origin iframes invisible to accessibility snapshots.
 * Uses CDP to locate the iframe and click the checkbox at the right coordinates.
 */

const CAPTCHA_IFRAME_PATTERNS = [
  /google\.com\/recaptcha/,
  /hcaptcha\.com\/captcha/,
  /challenges\.cloudflare\.com/,
];

const CAPTCHA_TITLE_PATTERNS = [
  /recaptcha/i,
  /hcaptcha/i,
  /cloudflare/i,
];

const CHECKBOX_SOLVED_PATTERNS = [
  /recaptcha-checkbox-checked/,
  /success/i,
];

const MAX_WAIT_MS = 15_000;
const POLL_INTERVAL_MS = 1_000;

interface CaptchaIframeInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  src: string;
  type: 'recaptcha' | 'hcaptcha' | 'turnstile' | 'unknown';
}

/**
 * Detect captcha iframes on the page via DOM inspection.
 * Returns iframe bounding rect info for CDP clicking.
 */
async function findCaptchaIframes(page: CrawlPage): Promise<CaptchaIframeInfo[]> {
  const result = await page.evaluate(`
    (function() {
      var IFRAME_SRC_PATTERNS = [
        /google\\.com\\/recaptcha/,
        /hcaptcha\\.com\\/captcha/,
        /challenges\\.cloudflare\\.com/
      ];
      var IFRAME_TITLE_PATTERNS = [
        /recaptcha/i,
        /hcaptcha/i,
        /cloudflare/i
      ];
      var results = [];
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        var iframe = iframes[i];
        var src = iframe.src || '';
        var title = iframe.title || '';
        var matched = false;
        var type = 'unknown';
        for (var p = 0; p < IFRAME_SRC_PATTERNS.length; p++) {
          if (IFRAME_SRC_PATTERNS[p].test(src)) {
            matched = true;
            type = ['recaptcha', 'hcaptcha', 'turnstile'][p];
            break;
          }
        }
        if (!matched) {
          for (var t = 0; t < IFRAME_TITLE_PATTERNS.length; t++) {
            if (IFRAME_TITLE_PATTERNS[t].test(title)) {
              matched = true;
              type = ['recaptcha', 'hcaptcha', 'turnstile'][t];
              break;
            }
          }
        }
        if (matched) {
          var rect = iframe.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            results.push({
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              src: src.substring(0, 200),
              type: type
            });
          }
        }
      }
      return JSON.stringify(results);
    })()
  `);

  if (!result) return [];
  return JSON.parse(result as string) as CaptchaIframeInfo[];
}

/**
 * Detect whether the page has a checkbox-style captcha.
 * Two detection paths:
 *   1. Text-based: domText contains captcha keywords (cheap but unreliable for cross-origin iframes)
 *   2. Iframe-based: scan DOM for captcha iframes by src/title (reliable, catches hidden ones)
 */
export async function detectCheckboxCaptcha(page: CrawlPage, domText: string, snapshot: string): Promise<boolean> {
  // Don't trigger if it's a press-and-hold style (that skill handles those)
  const isPressAndHold = /press.*hold|hold.*to.*confirm/i.test(domText);
  if (isPressAndHold) return false;

  // Path 1: text-based detection (fast, but misses cross-origin iframes)
  const hasCheckboxText = /i.m not a robot|i\'m not a robot|recaptcha|hcaptcha|verify you.re human|verify you are human|human verification/i.test(domText);
  if (hasCheckboxText) return true;

  // Path 2: iframe-based detection (catches hidden/cross-origin captchas)
  const iframes = await findCaptchaIframes(page);
  if (iframes.length > 0) {
    logger.info({ count: iframes.length, types: iframes.map(f => f.type) }, 'checkbox-captcha: detected via iframe scan (not visible in text)');
    return true;
  }

  return false;
}

/**
 * Get the click coordinates for the checkbox within a captcha iframe.
 * The checkbox is typically in the upper-left area of the iframe.
 */
function getCheckboxCoords(iframe: CaptchaIframeInfo): { x: number; y: number } {
  switch (iframe.type) {
    case 'recaptcha':
      // reCAPTCHA v2 checkbox is ~28px from left, ~28px from top of iframe
      return { x: iframe.x + 28, y: iframe.y + 28 };
    case 'hcaptcha':
      // hCaptcha checkbox is similarly positioned
      return { x: iframe.x + 28, y: iframe.y + 28 };
    case 'turnstile':
      // Turnstile checkbox is centered-left
      return { x: iframe.x + 35, y: iframe.y + Math.round(iframe.height / 2) };
    default:
      // Best guess: upper-left area where checkboxes typically are
      return { x: iframe.x + 28, y: iframe.y + 28 };
  }
}

async function openCdpConnection(page: CrawlPage) {
  const baseUrl = getCdpBaseUrl(page);
  const targetId = getTargetId(page);

  const res = await fetch(baseUrl + '/json');
  const targets = await res.json() as { id: string; webSocketDebuggerUrl: string }[];
  const target = targets.find(t => t.id === targetId);
  if (!target) throw new Error('CDP target not found');

  await activateCdpTarget(baseUrl, targetId);

  const ws = await import('ws');
  const socket = new ws.default(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('error', reject);
  });

  let msgId = 0;
  const send = (method: string, params: Record<string, unknown>) => new Promise<void>((resolve) => {
    const id = ++msgId;
    const onMsg = (data: Buffer) => {
      if (JSON.parse(data.toString()).id === id) {
        socket.off('message', onMsg);
        resolve();
      }
    };
    socket.on('message', onMsg);
    socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { socket.off('message', onMsg); resolve(); }, 3000);
  });

  return { send, close: () => socket.close() };
}

/**
 * Click the captcha checkbox and wait for verification to complete.
 */
export async function clickCheckboxCaptcha(page: CrawlPage): Promise<boolean> {
  try {
    logger.info('checkbox-captcha: scanning for captcha iframes');

    const iframes = await findCaptchaIframes(page);
    if (iframes.length === 0) {
      logger.info('checkbox-captcha: no captcha iframes found');
      return false;
    }

    logger.info({ count: iframes.length, types: iframes.map(f => f.type) }, 'checkbox-captcha: found captcha iframes');

    // Try each captcha iframe (usually there's just one)
    for (const iframe of iframes) {
      const coords = getCheckboxCoords(iframe);
      logger.info({ type: iframe.type, x: coords.x, y: coords.y, iframeRect: { x: iframe.x, y: iframe.y, w: iframe.width, h: iframe.height } }, 'checkbox-captcha: clicking checkbox');

      const cdp = await openCdpConnection(page);
      try {
        // Move mouse to checkbox position
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: coords.x, y: coords.y, button: 'none' });
        await new Promise(r => setTimeout(r, 200));

        // Click
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 100));
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });

        logger.info('checkbox-captcha: clicked, waiting for verification');

        // Wait for the captcha to resolve
        const start = Date.now();
        while (Date.now() - start < MAX_WAIT_MS) {
          await page.waitFor({ timeMs: POLL_INTERVAL_MS });

          // Check if the captcha iframe is gone or the page moved on
          const currentIframes = await findCaptchaIframes(page);
          if (currentIframes.length === 0) {
            logger.info('checkbox-captcha: captcha iframe gone — solved');
            return true;
          }

          // Check if captcha text is gone from page
          const domText = await page.evaluate(`document.body.innerText || ''`) as string;
          if (!/i.m not a robot|recaptcha|hcaptcha|verify you.re human/i.test(domText)) {
            logger.info('checkbox-captcha: captcha text gone — solved');
            return true;
          }

          // Check if a visual puzzle appeared (means checkbox was clicked but needs more)
          const hasPuzzle = await page.evaluate(`
            (function() {
              var iframes = document.querySelectorAll('iframe');
              for (var i = 0; i < iframes.length; i++) {
                var title = (iframes[i].title || '').toLowerCase();
                var src = (iframes[i].src || '').toLowerCase();
                if (/recaptcha.*challenge|bframe/i.test(src) || /challenge/i.test(title)) {
                  var rect = iframes[i].getBoundingClientRect();
                  if (rect.width > 200 && rect.height > 200) return true;
                }
              }
              return false;
            })()
          `) as boolean;

          if (hasPuzzle) {
            logger.info('checkbox-captcha: visual puzzle appeared — cannot solve automatically');
            return false;
          }
        }

        logger.info('checkbox-captcha: timed out waiting for verification');
      } finally {
        cdp.close();
      }
    }

    return false;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, 'checkbox-captcha: failed');
    return false;
  }
}
