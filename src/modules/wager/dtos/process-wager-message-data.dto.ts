import { IsString, Matches } from 'class-validator';
import { IDEMPOTENCY_KEY_PATTERN, ProcessWagerRequestDto } from './process-wager.dto';

export class ProcessWagerMessageDataDto extends ProcessWagerRequestDto {
  @IsString()
  @Matches(IDEMPOTENCY_KEY_PATTERN)
  declare idempotencyKey: string;
}
