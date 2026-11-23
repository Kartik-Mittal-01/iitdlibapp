// Live seat counts, shared by mapService (public occupancy reporting) and
// visitService (crowd-aware hold policy). Kept separate from mapService so
// visitService never has to require it (mapService already requires
// visitService, and a cycle would break require()).

const { LibraryTable, Seat } = require('../models')
const { holdPolicyForOccupancy } = require('../shared')

async function getCounts() {
  const activeTableIds = await LibraryTable.find({ isActive: true }).distinct('_id')
  const rows = await Seat.aggregate([
    { $match: { tableId: { $in: activeTableIds }, isActive: true } },
    { $group: { _id: '$status', n: { $sum: 1 } } }
  ])
  const counts = { available: 0, occupied: 0, reserved: 0 }
  for (const r of rows) counts[r._id] = r.n
  return { capacity: counts.available + counts.occupied + counts.reserved, ...counts }
}

async function getHoldPolicy() {
  const { capacity, occupied, reserved } = await getCounts()
  return holdPolicyForOccupancy(occupied + reserved, capacity)
}

module.exports = { getCounts, getHoldPolicy }
