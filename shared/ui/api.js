import { errorMessage } from '../libraryStates.mjs'

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * Small REST client for the library API.
 * @param {{ baseUrl: string, getToken?: () => Promise<string|null>|string|null,
 *           onUnauthorized?: () => Promise<boolean> }} options
 *   onUnauthorized may refresh credentials and return true to retry once.
 */
export function createApi({ baseUrl, getToken, onUnauthorized }) {
  async function request(method, path, { body, query, retry = true } = {}) {
    const url = new URL(baseUrl + path)
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v)
    }
    const token = getToken ? await getToken() : null
    const headers = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = `Bearer ${token}`

    let res
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    } catch {
      throw new ApiError(
        0,
        'NETWORK_ERROR',
        'Cannot reach the library server. Check the connection and try again.'
      )
    }
    const payload = await res.json().catch(() => null)
    if (res.status === 401 && retry && onUnauthorized && (await onUnauthorized())) {
      return request(method, path, { body, query, retry: false })
    }
    if (!res.ok || !payload?.success) {
      const e = payload?.error || {}
      const code = e.code || (res.status >= 500 ? 'INTERNAL_ERROR' : 'UNKNOWN')
      throw new ApiError(res.status, code, errorMessage(code, e.message), e.details)
    }
    return payload.data
  }

  return {
    get: (path, query) => request('GET', path, { query }),
    post: (path, body = {}) => request('POST', path, { body }),
    patch: (path, body = {}) => request('PATCH', path, { body })
  }
}
