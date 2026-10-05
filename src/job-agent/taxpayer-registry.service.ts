import { Injectable } from '@nestjs/common';

export type TaxpayerLookup =
  | { status: 'found'; voen: string; legalName: string; reference: string }
  | { status: 'not_found' }
  | { status: 'unavailable' };

/** Replace this provider only after a documented, authorized DVX integration is available.
 * There is deliberately no guessed endpoint, scraping bypass or format-only verification.
 */
@Injectable()
export class TaxpayerRegistryService {
  async lookup(_voen: string, _signal?: AbortSignal): Promise<TaxpayerLookup> {
    return { status: 'unavailable' };
  }
}
