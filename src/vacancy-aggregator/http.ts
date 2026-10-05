import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class SourceAccessError extends Error {}
export const privateAddress = (ip: string): boolean => {
  const v4 = ip.replace(/^::ffff:/i, '');
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  return !isIP(ip) || /^(::|fc|fd|fe[89ab])/i.test(ip);
};

export async function fetchFeed(
  url: string,
  allowedHost: string,
  signal: AbortSignal,
): Promise<string> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== allowedHost ||
    parsed.username ||
    parsed.password ||
    parsed.port
  )
    throw new SourceAccessError('Source URL is not approved');
  const addresses = await lookup(parsed.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => privateAddress(a.address)))
    throw new SourceAccessError('Private source destination');
  const response = await fetch(url, {
    signal,
    redirect: 'manual',
    headers: {
      'User-Agent': 'AdYaratVacancyCollector/1.0',
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
    },
  });
  if ([401, 403].includes(response.status) || (response.status >= 300 && response.status < 400))
    throw new SourceAccessError('Source refused access or redirected; no bypass attempted');
  if (!response.ok) throw new Error(`Feed HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > 1000000)
    throw new SourceAccessError('Feed too large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty feed response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1000000) throw new SourceAccessError('Feed too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds = 30000,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Source timeout'));
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
