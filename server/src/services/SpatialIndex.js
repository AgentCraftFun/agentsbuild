/**
 * Simple grid-based spatial index for buildings.
 * Eliminates O(n) scans when checking building spacing, proximity, etc.
 *
 * Cell size is 16 tiles — buildings in the same cell (or adjacent cells)
 * may be within spacing distance. Queries return candidates to test.
 *
 * This is a pure in-memory index. It is NOT persisted — it's rebuilt
 * from worldState.buildingsList on server startup via rebuild().
 */

const CELL_SIZE = 16;

class SpatialIndex {
  constructor() {
    this.cells = new Map(); // "cx,cy" -> Set of buildings
  }

  _cellKey(x, y) {
    const cx = Math.floor(x / CELL_SIZE);
    const cy = Math.floor(y / CELL_SIZE);
    return `${cx},${cy}`;
  }

  add(building) {
    if (!building || !isFinite(building.x) || !isFinite(building.y)) return;
    const key = this._cellKey(building.x, building.y);
    let cell = this.cells.get(key);
    if (!cell) { cell = new Set(); this.cells.set(key, cell); }
    cell.add(building);
  }

  remove(building) {
    if (!building || !isFinite(building.x) || !isFinite(building.y)) return;
    const key = this._cellKey(building.x, building.y);
    const cell = this.cells.get(key);
    if (cell) {
      cell.delete(building);
      if (cell.size === 0) this.cells.delete(key);
    }
  }

  /**
   * Return all buildings within `radius` tiles (Manhattan distance) of (x, y).
   * Scans only the cells that could contain matching buildings.
   */
  query(x, y, radius) {
    const results = [];
    const cxMin = Math.floor((x - radius) / CELL_SIZE);
    const cxMax = Math.floor((x + radius) / CELL_SIZE);
    const cyMin = Math.floor((y - radius) / CELL_SIZE);
    const cyMax = Math.floor((y + radius) / CELL_SIZE);
    for (let cy = cyMin; cy <= cyMax; cy++) {
      for (let cx = cxMin; cx <= cxMax; cx++) {
        const cell = this.cells.get(`${cx},${cy}`);
        if (!cell) continue;
        for (const b of cell) {
          if (Math.abs(b.x - x) + Math.abs(b.y - y) <= radius) results.push(b);
        }
      }
    }
    return results;
  }

  /**
   * Fast "is any building within distance N" check. Returns as soon as
   * one is found. Much faster than query() when you only need a boolean.
   */
  anyWithin(x, y, radius) {
    const cxMin = Math.floor((x - radius) / CELL_SIZE);
    const cxMax = Math.floor((x + radius) / CELL_SIZE);
    const cyMin = Math.floor((y - radius) / CELL_SIZE);
    const cyMax = Math.floor((y + radius) / CELL_SIZE);
    for (let cy = cyMin; cy <= cyMax; cy++) {
      for (let cx = cxMin; cx <= cxMax; cx++) {
        const cell = this.cells.get(`${cx},${cy}`);
        if (!cell) continue;
        for (const b of cell) {
          if (Math.abs(b.x - x) + Math.abs(b.y - y) < radius) return true;
        }
      }
    }
    return false;
  }

  /**
   * Rebuild the index from scratch from a list of buildings.
   * Called on server startup to initialize.
   */
  rebuild(buildings) {
    this.cells.clear();
    for (const b of buildings) this.add(b);
  }

  size() {
    let total = 0;
    for (const cell of this.cells.values()) total += cell.size;
    return total;
  }
}

module.exports = SpatialIndex;
