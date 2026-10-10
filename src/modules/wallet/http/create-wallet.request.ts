import { Type } from 'class-transformer';
import { IsString, Matches, ValidateNested } from 'class-validator';

export class MoneyRequest {
  @IsString()
  @Matches(/^(?:0|[0-9]+)(?:\.[0-9]{1,2})?$/)
  declare amount: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  declare currency: string;
}

export class CreateWalletRequest {
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  declare playerId: string;

  @ValidateNested()
  @Type(() => MoneyRequest)
  declare initialBalance: MoneyRequest;
}
