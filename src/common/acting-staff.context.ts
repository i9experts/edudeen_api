import { AsyncLocalStorage } from 'async_hooks';
import type { Schema } from 'mongoose';

/**
 * Who is really behind a seller-role request made in an admin "manage as seller" session (act-as.util.ts).
 * The act-as middleware runs the rest of a WRITE request inside this context, so models can stamp the acting
 * staff member's id on what they create or change without every service passing it along. Outside an act-as
 * write request `actingStaffId()` is null and nothing is stamped.
 */
export interface ActingStaff {
  staffId: string;
  storeId: string;
}

const als = new AsyncLocalStorage<ActingStaff>();

export const runAsActingStaff = <T>(actor: ActingStaff, fn: () => T): T =>
  als.run(actor, fn);

/** Admin/staff account id acting as the seller in this request, or null. */
export const actingStaffId = (): string | null =>
  als.getStore()?.staffId ?? null;

interface PluginOptions {
  /** Set once, on create. */
  createdField?: string;
  /** Set on create and on every update (with `editedAtField`). */
  editedField?: string;
  editedAtField?: string;
}

/** Mongoose plugin: stamps the acting staff id (see above) on documents created or updated in an act-as request. */
export function actingStaffPlugin(schema: Schema, opts: PluginOptions) {
  const { createdField, editedField, editedAtField } = opts;
  // The fields are select:false, but a freshly created/saved document still carries them in memory: strip them
  // whenever a document is serialised (API responses, socket emits). Reports read them via lean + explicit select.
  const hidden = [createdField, editedField, editedAtField].filter(
    Boolean,
  ) as string[];
  for (const kind of ['toJSON', 'toObject'] as const) {
    const prev = (schema.get(kind) ?? {}) as { transform?: unknown };
    const prevTransform =
      typeof prev.transform === 'function'
        ? (prev.transform as (d: unknown, r: any, o: unknown) => any)
        : null;
    schema.set(kind, {
      ...prev,
      transform: (doc: unknown, ret: any, o: unknown) => {
        const out = prevTransform ? (prevTransform(doc, ret, o) ?? ret) : ret;
        for (const f of hidden) delete out[f];
        return out;
      },
    });
  }
  const stamp = (doc: any, id: string, isNew: boolean) => {
    if (isNew && createdField && doc[createdField] == null)
      doc[createdField] = id;
    if (editedField) doc[editedField] = id;
    if (editedAtField) doc[editedAtField] = new Date();
  };

  schema.pre('save', function () {
    const id = actingStaffId();
    if (!id) return;
    const doc = this as any;
    if (doc.isNew && createdField && doc.get(createdField) == null)
      doc.set(createdField, id);
    if (editedField) doc.set(editedField, id);
    if (editedAtField) doc.set(editedAtField, new Date());
  });

  // Mongoose 9: insertMany pre hooks get the docs first and no `next`.
  schema.pre('insertMany', function (docs: any) {
    const id = actingStaffId();
    if (id)
      for (const d of Array.isArray(docs) ? docs : [docs])
        if (d && typeof d === 'object') stamp(d, id, true);
  });

  if (editedField) {
    schema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], function () {
      const id = actingStaffId();
      if (!id) return;
      const q = this as any;
      const update = q.getUpdate();
      if (!update || Array.isArray(update)) return; // aggregation-pipeline updates are left alone
      update.$set = {
        ...(update.$set ?? {}),
        [editedField]: id,
        ...(editedAtField ? { [editedAtField]: new Date() } : {}),
      };
      q.setUpdate(update);
    });
  }
}
