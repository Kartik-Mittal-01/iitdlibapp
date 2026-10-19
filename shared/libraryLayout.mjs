// Physical floor plan of the library, recreated from librarymap.png (project root).
//
// The reference is a spreadsheet drawing: 22 columns x 29 rows. Every table and
// fixture below is placed on that same grid, so the relative arrangement and
// grouping match the reference. Column widths are made uniform (the uneven
// spreadsheet column widths carry no meaning) so that every table stays legible.
//
// The reference has no table labels. IDs are sequential, numbered left->right,
// top->bottom (by the table's top-left cell):
//   8-seat tables  E01-E47
//   2-seat tables  P01-P61
//
// This module is used by server/scripts/seed.js to create the tables in MongoDB
// and by the map component for the non-table fixtures. At runtime the map is
// always drawn from the backend's table data (codes, positions, live counts).

export const GRID = Object.freeze({
  columns: 22,
  rows: 29,
  cellWidth: 100,
  cellHeight: 40
})

export const LAYOUT_CANVAS = Object.freeze({
  width: GRID.columns * GRID.cellWidth,
  height: GRID.rows * GRID.cellHeight
})

function rect(col, row, cols = 1, rows = 1) {
  return {
    x: col * GRID.cellWidth,
    y: row * GRID.cellHeight,
    width: cols * GRID.cellWidth,
    height: rows * GRID.cellHeight
  }
}

// [col, row, cols, rows] for every table in the reference drawing.
const TWO_SEATERS = [
  // Top wall: one row of 20 cells (columns 1-20).
  ...Array.from({ length: 20 }, (_, i) => [1 + i, 0, 1, 1]),
  // Left wall: 9 above the stairs (rows 2-10), 7 below (rows 15-21).
  ...Array.from({ length: 9 }, (_, i) => [0, 2 + i, 1, 1]),
  ...Array.from({ length: 7 }, (_, i) => [0, 15 + i, 1, 1]),
  // Right wall: 7 above the entry gate (rows 2-8), 12 below (rows 12-23).
  ...Array.from({ length: 7 }, (_, i) => [21, 2 + i, 1, 1]),
  ...Array.from({ length: 12 }, (_, i) => [21, 12 + i, 1, 1]),
  // Bottom row: 6 cells (columns 2-7) on the last row.
  ...Array.from({ length: 6 }, (_, i) => [2 + i, 28, 1, 1])
]

const EIGHT_SEATERS = [
  // Left block: horizontal tables, each two columns wide, four per row.
  ...[3, 6, 9, 16, 19, 22].flatMap((row) => [2, 4, 6, 8].map((col) => [col, row, 2, 1])),
  ...[2, 4, 6].map((col) => [col, 25, 2, 1]),
  // Right block: five columns of four vertical tables, each two rows tall.
  ...[11, 13, 15, 17, 19].flatMap((col) => [3, 5, 7, 9].map((row) => [col, row, 1, 2]))
]

function numbered(cells, prefix, capacity) {
  return [...cells]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([col, row, cols, rows], i) => {
      const n = String(i + 1).padStart(2, '0')
      return {
        tableCode: `${prefix}${n}`,
        name: `${capacity}-seat table ${prefix}${n}`,
        capacity,
        location: rect(col, row, cols, rows)
      }
    })
}

export const REFERENCE_TABLES = Object.freeze([
  ...numbered(EIGHT_SEATERS, 'E', 8),
  ...numbered(TWO_SEATERS, 'P', 2)
])

// Non-seating areas drawn on the map.
export const MAP_FIXTURES = Object.freeze([
  { id: 'stairs', label: 'Stairs', ...rect(0, 11, 4, 4) },
  { id: 'entry-gate', label: 'Entry gate', ...rect(21, 9, 1, 3) }
])
