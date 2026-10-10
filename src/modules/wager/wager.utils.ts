import { createHash } from 'node:crypto';
import type { ExternalWagerKind } from './domain/wager-transaction';

export interface CanonicalWagerData {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: ExternalWagerKind;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export function createCanonicalWagerHash(data: CanonicalWagerData): string {
  const canonicalData: Record<string, unknown> = {
    providerId: data.providerId,
    externalTransactionId: data.externalTransactionId,
    playerId: data.playerId,
    walletId: data.walletId,
    roundId: data.roundId,
    gameId: data.gameId,
    kind: data.kind,
    money: data.money,
  };
  if (data.referenceExternalTransactionId !== undefined) {
    canonicalData.referenceExternalTransactionId = data.referenceExternalTransactionId;
  }

  return createHash('sha256').update(canonicalJson(canonicalData)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
