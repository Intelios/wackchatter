import type { Database } from 'bun:sqlite';
import { type GroupConfig, type GroupTemplate, validateGroup } from '../../shared/types/group.ts';
import { getDb } from './db.ts';

type Row = { id: string; revision: number; created: number; modified: number; config: string };
export function createGroupStore(db: Database) {
  const decode = (row: Row): GroupTemplate => ({
    ...JSON.parse(row.config),
    id: row.id,
    revision: row.revision,
    created: row.created,
    modified: row.modified,
  });
  const get = (id: string) => {
    const row = db.query<Row, [string]>('SELECT * FROM groups WHERE id = ?').get(id);
    return row ? decode(row) : null;
  };
  return {
    get,
    list: () => db.query<Row, []>('SELECT * FROM groups ORDER BY modified DESC').all().map(decode),
    create(config: GroupConfig) {
      if (!validateGroup(config))
        throw new Error('A group needs two distinct characters and valid settings.');
      const id = crypto.randomUUID();
      const now = Date.now();
      db.query(
        'INSERT INTO groups (id, revision, created, modified, config) VALUES (?, 0, ?, ?, ?)',
      ).run(id, now, now, JSON.stringify(config));
      return get(id)!;
    },
    save(id: string, revision: number, config: GroupConfig) {
      if (!validateGroup(config)) throw new Error('Invalid group configuration.');
      const result = db
        .query(
          'UPDATE groups SET config = ?, modified = ?, revision = revision + 1 WHERE id = ? AND revision = ?',
        )
        .run(JSON.stringify(config), Date.now(), id, revision);
      return result.changes ? get(id) : null;
    },
    remove: (id: string) => db.query('DELETE FROM groups WHERE id = ?').run(id).changes > 0,
  };
}
// Resolve the live database on every call; no extra relocation lifecycle.
export const groupStore = () => createGroupStore(getDb());
