import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const ledgerCursorSchema = z.object({
  createdAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  id: z.uuid(),
}).strict();

export function parseLedgerCursor(value: string | undefined): { createdAt: string; id: string } | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const result = ledgerCursorSchema.safeParse(decoded);
    if (!result.success) throw new BadRequestException('Invalid ledger cursor');
    return result.data;
  } catch (error: unknown) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException('Invalid ledger cursor');
  }
}
