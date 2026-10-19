function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data })
}

function parsePagination(query, { defaultLimit = 25, maxLimit = 100 } = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1)
  const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(query.limit, 10) || defaultLimit))
  return { page, limit, skip: (page - 1) * limit }
}

function paginated(items, total, { page, limit }) {
  return { items, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }
}

module.exports = { ok, parsePagination, paginated }
