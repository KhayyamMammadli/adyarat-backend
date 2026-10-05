import { SourceAdapter, RawVacancy } from './types';
import { parseRss, parseJobPosting } from './parsers';
import { fetchFeed } from './http';

export class BossAdapter implements SourceAdapter {
  readonly source = 'boss_az';
  readonly enabled = false;
  readonly disabledReason =
    'Automated access prohibited by current terms; no approved API/feed agreement.';
  async collect(): Promise<RawVacancy[]> {
    return [];
  }
  // Prepared for a future agreed syndicated feed, never fetched while disabled.
  parse(payload: string): RawVacancy[] {
    return parseRss(payload);
  }
}
export class HelloJobAdapter implements SourceAdapter {
  readonly source = 'hellojob_az';
  readonly enabled = false;
  readonly disabledReason =
    'HTTP/robots probes returned 403; official API/feed and automated-use permission not verified.';
  async collect(): Promise<RawVacancy[]> {
    return [];
  }
  // Offline standard parser only; site's live markup could not be validated.
  parse(payload: string): RawVacancy[] {
    return parseJobPosting(payload);
  }
}

export class AuthorizedRssAdapter implements SourceAdapter {
  readonly enabled = true;
  constructor(
    readonly source: string,
    private readonly url: string,
    private readonly host: string,
    readonly permissionReference: string,
  ) {
    if (!permissionReference.trim()) throw new Error('A source permission reference is required');
    if (/(^|\.)(boss|hellojob)\.az$/i.test(new URL(url).hostname))
      throw new Error('Blocked MVP sources require a reviewed adapter change');
  }
  async collect(signal: AbortSignal): Promise<RawVacancy[]> {
    return parseRss(await fetchFeed(this.url, this.host, signal));
  }
}

export function configuredAdapters(env: NodeJS.ProcessEnv): SourceAdapter[] {
  const sources: SourceAdapter[] = [new BossAdapter(), new HelloJobAdapter()];
  if (env.COLLECTOR_RSS_URL) {
    if (!env.COLLECTOR_RSS_HOST || !env.COLLECTOR_RSS_SOURCE || !env.COLLECTOR_RSS_PERMISSION)
      throw new Error('Authorized RSS configuration is incomplete');
    sources.push(
      new AuthorizedRssAdapter(
        env.COLLECTOR_RSS_SOURCE,
        env.COLLECTOR_RSS_URL,
        env.COLLECTOR_RSS_HOST,
        env.COLLECTOR_RSS_PERMISSION,
      ),
    );
  }
  return sources;
}
