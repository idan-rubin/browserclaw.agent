import type { CrawlPage } from 'browserclaw';
import { getCdpBaseUrl, getTargetId, activateCdpTarget } from './cdp-utils.js';
import { logger } from '../logger.js';

const ANTI_BOT_PATTERN = /press.*hold|verify.*human|not a bot|captcha/i;
const HOLD_DURATION_MS = 5_000;
const MAX_WAIT_MS = 15_000;
const POLL_INTERVAL_MS = 1_000;

async function findButtonCoordinates(page: CrawlPage): Promise<{ x: number; y: number } | null> {
  const result = await page.evaluate(`
    (function() {
      var PATTERN = /press.*hold|verify.*human|hold.*to.*confirm|not a bot/i;
      var BUTTON_Y_OFFSET = 60;

      function toCandidate(el, source, offsetX, offsetY) {
        var rect = el.getBoundingClientRect();
        return {
          text: (el.innerText || '').trim().substring(0, 80),
          width: rect.width,
          height: rect.height,
          x: Math.round(rect.left + rect.width / 2 + offsetX),
          y: Math.round(rect.bottom + BUTTON_Y_OFFSET + offsetY),
          tag: el.tagName,
          source: source
        };
      }

      function matchingElements(root, source, offsetX, offsetY) {
        var results = [];
        var all = root.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (PATTERN.test((el.innerText || '').trim())) {
            results.push(toCandidate(el, source, offsetX, offsetY));
          }
          if (el.shadowRoot) {
            var shadowAll = el.shadowRoot.querySelectorAll('*');
            for (var s = 0; s < shadowAll.length; s++) {
              if (PATTERN.test((shadowAll[s].innerText || '').trim())) {
                results.push(toCandidate(shadowAll[s], 'shadow', offsetX, offsetY));
              }
            }
          }
        }
        return results;
      }

      function searchIframes() {
        var results = [];
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          try {
            var doc = iframes[i].contentDocument;
            if (doc && doc.body) {
              var rect = iframes[i].getBoundingClientRect();
              results = results.concat(matchingElements(doc, 'iframe', rect.left, rect.top));
            }
          } catch(e) {}
        }
        return results;
      }

      function pickBest(candidates) {
        var best = null;
        for (var i = 0; i < candidates.length; i++) {
          var c = candidates[i];
          if (c.width > 100 && c.height > 20 && c.height < 80) {
            if (!best || c.height < best.height) best = c;
          }
        }
        return best;
      }

      var candidates = matchingElements(document, 'dom', 0, 0).concat(searchIframes());
      var best = pickBest(candidates);
      return JSON.stringify({ found: !!best, best: best, candidates: candidates });
    })()
  `);

  if (!result) return null;

  const parsed = JSON.parse(result as string);
  logger.info({ found: parsed.found, candidateCount: parsed.candidates?.length, candidates: parsed.candidates?.map((c: { text: string; width: number; height: number; tag: string }) => ({ text: c.text, w: c.width, h: c.height, tag: c.tag })) }, 'press-and-hold: button search');

  if (!parsed.found || !parsed.best) return null;
  return { x: parsed.best.x, y: parsed.best.y };
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

export async function getPageText(page: CrawlPage): Promise<string> {
  return await page.evaluate(`
    (function() {
      var text = document.body.innerText || '';
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        try {
          if (iframes[i].contentDocument && iframes[i].contentDocument.body) {
            text += ' ' + iframes[i].contentDocument.body.innerText;
          }
        } catch(e) {}
      }
      return text;
    })()
  `) as string;
}

export function detectAntiBot(domText: string, snapshot: string): boolean {
  const detected = ANTI_BOT_PATTERN.test(domText) && !/press.*hold/i.test(snapshot);
  if (detected) {
    logger.info({ domTextPreview: domText.substring(0, 150) }, 'Anti-bot overlay detected');
  }
  return detected;
}

export function enrichSnapshot(snapshot: string, domText: string): string {
  return snapshot + `\n\n[ANTI-BOT OVERLAY DETECTED] The page has an anti-bot verification overlay not visible in the accessibility snapshot. The page text says: "${domText.substring(0, 200)}". Use press_and_hold to solve it.`;
}

export async function pressAndHold(page: CrawlPage): Promise<boolean> {
  try {
    logger.info('press-and-hold: starting');

    const coords = await findButtonCoordinates(page);
    if (!coords) {
      logger.info('press-and-hold: no suitable button found');
      return false;
    }
    const { x, y } = coords;
    logger.info({ x, y }, 'press-and-hold: found button, opening CDP');

    const cdp = await openCdpConnection(page);
    logger.info('press-and-hold: CDP connected');
    try {
      const urlBefore = await page.url();

      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      await new Promise(r => setTimeout(r, 100));
      logger.info({ x, y }, 'press-and-hold: mousePressed');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });

      await new Promise(r => setTimeout(r, HOLD_DURATION_MS));
      logger.info('press-and-hold: held for 5s, checking result');

      const start = Date.now();
      while (Date.now() - start < MAX_WAIT_MS) {
        await page.waitFor({ timeMs: POLL_INTERVAL_MS });
        const currentUrl = await page.url();
        if (currentUrl !== urlBefore) {
          logger.info({ urlBefore, currentUrl }, 'press-and-hold: URL changed');
          break;
        }
        const resolved = await page.evaluate(`!document.body.innerText.match(/press.*hold|verify.*human|not a bot/i)`);
        if (resolved) {
          logger.info('press-and-hold: anti-bot text gone');
          break;
        }
      }

      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      logger.info('press-and-hold: mouseReleased');
    } finally {
      cdp.close();
    }
    await page.waitFor({ timeMs: 2000 });

    const stillBlocked = await page.evaluate(`!!document.body.innerText.match(/press.*hold|verify.*human|not a bot|access.*denied/i)`);
    logger.info({ stillBlocked }, 'press-and-hold: result');
    return !stillBlocked;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, 'press-and-hold: failed');
    return false;
  }
}
