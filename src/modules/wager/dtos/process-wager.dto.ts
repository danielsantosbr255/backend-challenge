import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import type { Money } from '@/modules/wallet/domain/money';
import type { MoneyProps } from '@/modules/wallet/domain/money';
import { MoneyDto } from '@/common/dtos/money.dto';

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

  @IsIn(['BET', 'WIN', 'LOSS'])
  declare kind: 'BET' | 'WIN' | 'LOSS';

  @ValidateNested()
  @Type(() => MoneyDto)
  declare money: MoneyDto;

  @IsOptional()
  @IsString()
  @Matches(/^.{1,255}$/)
  declare referenceExternalTransactionId?: string;
}

export interface ProcessWagerInputDto {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: 'BET' | 'WIN' | 'LOSS';
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface ProcessWagerResponseDto {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED';
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: string;
}
