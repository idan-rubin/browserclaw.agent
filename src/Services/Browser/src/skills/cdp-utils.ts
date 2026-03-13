import type { CrawlPage } from 'browserclaw';

export function getCdpBaseUrl(page: CrawlPage): string {
  const cdpUrl = (page as unknown as { cdpUrl: string }).cdpUrl;
  return cdpUrl.replace('ws://', 'http://').replace(/\/devtools\/browser\/.*/, '').replace(/\/$/, '');
}

export function getTargetId(page: CrawlPage): string {
  return (page as unknown as { targetId: string }).targetId;
}

export async function activateCdpTarget(cdpBaseUrl: string, targetId: string): Promise<void> {
  const ws = await import('ws');
  const versionRes = await fetch(cdpBaseUrl + '/json/version');
  const versionInfo = await versionRes.json() as { webSocketDebuggerUrl: string };
  const browserWs = new ws.default(versionInfo.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    browserWs.on('open', resolve);
    browserWs.on('error', reject);
  });
  browserWs.send(JSON.stringify({ id: 1, method: 'Target.activateTarget', params: { targetId } }));
  await new Promise(r => setTimeout(r, 300));
  browserWs.close();
}

export interface CdpConnection {
  send: (method: string, params: Record<string, unknown>) => Promise<void>;
  close: () => void;
}

export async function openCdpConnection(page: CrawlPage): Promise<CdpConnection> {
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
