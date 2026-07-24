// Type declarations for the vendored cron-parser lib (v1.1.1, CJS, dep-free).
declare module "../vendor/cron-parser/lib/parser.js" {
  export interface CronExpressionIter {
    next(): Date;
    prev(): Date;
    hasNext(): boolean;
  }
  export interface ParseOptions { currentDate?: Date; endDate?: Date; iterator?: boolean; }
  export function parseExpression(expression: string, options?: ParseOptions): CronExpressionIter;
  export function parseString(entry: string): unknown;
  export function parseFile(filePath: string): unknown;
}