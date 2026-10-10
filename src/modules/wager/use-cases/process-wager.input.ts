import type { Money } from '@/modules/wallet/domain/money';
import type { ExternalWagerKind } from '../domain/wager-transaction';

export interface ProcessWagerInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: ExternalWagerKind;
  money: Money;
  referenceExternalTransactionId?: string;
}
