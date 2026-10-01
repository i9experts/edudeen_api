/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- reflection helpers */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { ValidationPipe } from '@nestjs/common';
import { GLOBAL_VALIDATION_OPTIONS } from './validation.config';
import { UpdateGiftCardSettingsDto } from '../gift-cards/dto/update-gift-card-settings.dto';
import { pickAddressUpdate } from '../address/address.service';

const walk = (dir: string, out: string[] = []): string[] => {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) out.push(p);
  }
  return out;
};

/**
 * The app-wide ValidationPipe runs with `whitelist: true`, which silently DROPS every property that has no
 * class-validator decorator. A DTO property someone adds without one would therefore vanish from requests with no
 * error. This guard fails the build instead.
 */
describe('global ValidationPipe whitelist', () => {
  it('no validated DTO declares a property without a class-validator decorator', () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(__dirname, '..'))) {
      const src = fs.readFileSync(file, 'utf8');
      if (!src.includes('class-validator')) continue;
      const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
      const validators = new Set<string>();
      sf.forEachChild((n) => {
        if (
          ts.isImportDeclaration(n) &&
          (n.moduleSpecifier as ts.StringLiteral).text === 'class-validator'
        ) {
          const nb = n.importClause?.namedBindings;
          if (nb && ts.isNamedImports(nb))
            nb.elements.forEach((e) => validators.add(e.name.text));
        }
      });
      const isValidator = (d: ts.Decorator) => {
        const e = d.expression;
        return validators.has(
          ts.isCallExpression(e) ? e.expression.getText() : e.getText(),
        );
      };
      const visit = (n: ts.Node) => {
        if (ts.isClassDeclaration(n) && n.name) {
          const props = n.members.filter(ts.isPropertyDeclaration);
          const validated = props.some((m) =>
            (ts.getDecorators(m) ?? []).some(isValidator),
          );
          if (validated) {
            for (const m of props) {
              if (!(ts.getDecorators(m) ?? []).some(isValidator))
                offenders.push(
                  `${path.relative(process.cwd(), file)} ${n.name.text}.${m.name.getText()}`,
                );
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(offenders).toEqual([]);
  });

  it('unknown properties are stripped from a DTO body (mass assignment)', async () => {
    const pipe = new ValidationPipe(GLOBAL_VALIDATION_OPTIONS);
    const out: any = await pipe.transform(
      {
        enabled: true,
        storeId: 'someone-elses-store',
        _id: 'x',
        $set: { a: 1 },
      },
      { type: 'body', metatype: UpdateGiftCardSettingsDto },
    );
    expect(out.storeId).toBeUndefined();
    expect(out._id).toBeUndefined();
    expect(out.$set).toBeUndefined();
  });
});

describe('pickAddressUpdate', () => {
  it('keeps only address fields — never userId / isDelete / status', () => {
    const out = pickAddressUpdate({
      city: 'Lahore',
      userId: 'victim',
      isDelete: false,
      status: 'x',
      $where: '1',
      isDefault: true,
      latitude: 31.5,
    });
    expect(out).toEqual({ city: 'Lahore', isDefault: true, latitude: 31.5 });
  });
  it('rejects non-string / oversized / operator values', () => {
    expect(() => pickAddressUpdate({ city: { $ne: null } })).toThrow();
    expect(() => pickAddressUpdate({ city: 'x'.repeat(201) })).toThrow();
    expect(() => pickAddressUpdate({ isDefault: 'true' })).toThrow();
    expect(() => pickAddressUpdate({ latitude: '31' })).toThrow();
  });
});
