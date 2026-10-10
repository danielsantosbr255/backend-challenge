import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Money } from '@/modules/wallet/domain/money';
import type { ProcessWagerInput } from '@/modules/wager/use-cases/process-wager.input';
import { WagerTransactionRequestedDto } from '@/modules/wager/dtos/wager-transaction-requested.dto';

export interface WagerTransactionRequested {
  messageId: string;
  data: ProcessWagerInput;
}

export function parseWagerMessage(body: string | undefined): WagerTransactionRequested | undefined {
  if (body === undefined) return undefined;

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return undefined;

  const message = plainToInstance(WagerTransactionRequestedDto, json);
  if (validateSync(message, { whitelist: true, forbidNonWhitelisted: true }).length > 0) {
    return undefined;
  }

  try {
    const { data } = message;
    const money = Money.from(data.money);
    if (!money.isPositive()) return undefined;

    return {
      messageId: message.messageId,
      data: {
        providerId: data.providerId,
        externalTransactionId: data.externalTransactionId,
        idempotencyKey: data.idempotencyKey,
        playerId: data.playerId.toLowerCase(),
        walletId: data.walletId.toLowerCase(),
        roundId: data.roundId,
        gameId: data.gameId,
        kind: data.kind,
        money,
        ...(data.referenceExternalTransactionId === undefined
          ? {}
          : { referenceExternalTransactionId: data.referenceExternalTransactionId }),
      },
    };
  } catch {
    return undefined;
  }
}
