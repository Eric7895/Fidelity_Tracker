const BASE_URL =
  import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:8000'


export async function getRequest(endpoint, params = {}) {
  const url = new URL(`${BASE_URL}${endpoint}`)

  for (const [key, value] of Object.entries(params)) {
    // Empty strings and "all" both mean that the backend should not
    // apply that filter, so we leave them out of the query string.
    if (
      value !== undefined &&
      value !== null &&
      value !== '' &&
      value !== 'all'
    ) {
      url.searchParams.set(key, value)
    }
  }

  const response = await fetch(url)

  if (!response.ok) {
    const text = await response.text()

    throw new Error(
      text || `Request failed: ${response.status}`
    )
  }

  return response.json()
}