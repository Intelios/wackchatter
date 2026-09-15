/**
 * Custom-header list edits for the connection panel.
 *
 * Pure and separate from the panel because there is no DOM harness here: the logic
 * worth testing has to live somewhere a test can reach it. Every function returns a
 * new array or record — the settings patch replaces the header record wholesale.
 *
 * Rows are a UI shape. The stored form is a plain `Record<string, string>` with no
 * identity to edit against, so the panel edits rows and converts on commit.
 */

export interface HeaderRow {
  id: string;
  name: string;
  value: string;
}

/** The stored record becomes rows, in stored order, with fresh edit identities. */
export function headersToRows(headers: Record<string, string> | undefined): HeaderRow[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({
    id: crypto.randomUUID(),
    name,
    value,
  }));
}

/**
 * Rows become the stored record: blank names are dropped, names and values are
 * trimmed, and a later duplicate name wins. `{}` clears the record — the patch
 * replaces it wholesale, so an omitted key would keep the old headers.
 */
export function rowsToHeaders(rows: HeaderRow[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    headers[name] = row.value.trim();
  }
  return headers;
}

export function addRow(rows: HeaderRow[], id: string): HeaderRow[] {
  return [...rows, { id, name: '', value: '' }];
}

export function updateRow(
  rows: HeaderRow[],
  id: string,
  patch: Partial<Omit<HeaderRow, 'id'>>,
): HeaderRow[] {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

export function removeRow(rows: HeaderRow[], id: string): HeaderRow[] {
  return rows.filter((row) => row.id !== id);
}
