import { Type } from 'class-transformer';
import { IsString, Matches, ValidateNested } from 'class-validator';
import { MoneyDto } from '@/common/dtos/money.dto';

export class CreateWalletRequestDto {
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  declare playerId: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  declare initialBalance: MoneyDto;
}
