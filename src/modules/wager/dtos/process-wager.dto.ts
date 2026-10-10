import { Type } from 'class-transformer';
import { IsDefined, IsIn, IsObject, IsString, Matches, ValidateIf, ValidateNested } from 'class-validator';
import { MoneyDto } from '@/common/dtos/money.dto';
import type { ExternalWagerKind } from '../domain/wager-transaction';

export const IDEMPOTENCY_KEY_PATTERN = /^(?=.*\S).{1,255}$/;

export class ProcessWagerRequestDto {
  @IsString()
  @Matches(/^[a-zA-Z0-9._:-]{1,100}$/)
  declare providerId: string;

  @IsString()
  @Matches(/^.{1,255}$/)
  declare externalTransactionId: string;

  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  declare playerId: string;

  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  declare walletId: string;

  @IsString()
  @Matches(/^.{1,255}$/)
  declare roundId: string;

  @IsString()
  @Matches(/^.{1,255}$/)
  declare gameId: string;

  @IsIn(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'])
  declare kind: ExternalWagerKind;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => MoneyDto)
  declare money: MoneyDto;

  @ValidateIf((request: ProcessWagerRequestDto) =>
    request.referenceExternalTransactionId !== undefined || request.kind === 'REFUND' || request.kind === 'ROLLBACK',
  )
  @IsString()
  @Matches(/^.{1,255}$/)
  declare referenceExternalTransactionId?: string;
}
