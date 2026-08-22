import { supabase } from './supabase'

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}, retry = true): Promise<Response> {
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) throw new Error('Sign in to continue.')
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${data.session.access_token}`)
  const response = await fetch(input, { ...init, headers })
  const jwtClockSkew = response.status === 503 && /jwt issued at future/i.test(await response.clone().text())
  if ((response.status !== 401 && !jwtClockSkew) || !retry) return response

  const refreshed = await supabase.auth.refreshSession()
  if (refreshed.error || !refreshed.data.session) return response
  if (jwtClockSkew) await new Promise((resolve) => window.setTimeout(resolve, 750))
  const refreshedHeaders = new Headers(init.headers)
  refreshedHeaders.set('Authorization', `Bearer ${refreshed.data.session.access_token}`)
  return fetch(input, { ...init, headers: refreshedHeaders })
}
