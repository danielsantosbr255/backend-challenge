import { IsISO4217CurrencyCode, IsString, Matches } from 'class-validator';

export class MoneyDto {
  @IsString()
  @Matches(/^(?:0|[0-9]+)(?:\.[0-9]{1,2})?$/)
  declare amount: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  @IsISO4217CurrencyCode()
  declare currency: string;
}
