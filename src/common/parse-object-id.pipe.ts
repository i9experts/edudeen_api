import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';

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
