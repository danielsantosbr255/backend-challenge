import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsString, Matches, ValidateNested } from 'class-validator';
import { ProcessWagerMessageDataDto } from './process-wager-message-data.dto';

export class WagerTransactionRequestedDto {
  @IsString()
  @Matches(/^.{1,255}$/)
  declare messageId: string;

  @IsIn(['WagerTransactionRequested'])
  declare type: 'WagerTransactionRequested';

  @IsDateString()
  declare occurredAt: string;

  @ValidateNested()
  @Type(() => ProcessWagerMessageDataDto)
  declare data: ProcessWagerMessageDataDto;
}
