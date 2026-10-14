import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';

/** Same check, but an absent value (undefined / null / '') passes through as undefined - for optional ids. */
@Injectable()
export class OptionalParseObjectIdPipe implements PipeTransform<unknown, string | undefined> {
  private readonly inner = new ParseObjectIdPipe();
  transform(value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    return this.inner.transform(value);
  }
}

/** Route-param guard: a malformed id is a 400 instead of a Mongoose CastError surfacing as a 500. */
@Injectable()
export class ParseObjectIdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (
      typeof value !== 'string' ||
      !/^[a-f\d]{24}$/i.test(value) ||
      !isValidObjectId(value)
    ) {
      throw new BadRequestException('Invalid id');
    }
    return value;
  }
}
