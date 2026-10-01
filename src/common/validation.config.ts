import type { ValidationPipeOptions } from '@nestjs/common';

/** Options of the app-wide ValidationPipe (main.ts). Exported so a test can assert the exact same behaviour. */
export const GLOBAL_VALIDATION_OPTIONS: ValidationPipeOptions = {
  transform: true,
  whitelist: true,
};
