import { describe, it, expect, vi } from 'vitest';
import { handleDeleteAccountRequest } from '../edge-functions/delete-account/index.ts';

const env = {
  get(name) {
    return {
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_ANON_KEY: 'anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      APP_ORIGIN: 'https://app.example.com'
    }[name];
  }
};

function fetchSequence(responses) {
  return vi.fn(async () => responses.shift());
}

function request(method = 'POST', includeAuthorization = true) {
  const headers = { Origin: 'https://app.example.com' };
  if (includeAuthorization) headers.Authorization = 'Bearer user-access-token';
  return new Request('https://project.supabase.co/functions/v1/delete-account', {
    method,
    headers
  });
}

describe('delete-account edge function', () => {
  it('rejects a request without a bearer token before making backend calls', async () => {
    const fetcher = fetchSequence([]);
    const response = await handleDeleteAccountRequest(request('POST', false), env, fetcher);

    expect(response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects requests without a verified user token', async () => {
    const fetcher = fetchSequence([new Response('', { status: 401 })]);
    const response = await handleDeleteAccountRequest(request(), env, fetcher);

    expect(response.status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refuses anonymous sessions without invoking cleanup or auth admin', async () => {
    const fetcher = fetchSequence([
      Response.json({ id: 'user-123', is_anonymous: true })
    ]);
    const response = await handleDeleteAccountRequest(request(), env, fetcher);

    expect(response.status).toBe(403);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not delete the auth user if application-data cleanup fails', async () => {
    const fetcher = fetchSequence([
      Response.json({ id: 'user-123', is_anonymous: false }),
      new Response('', { status: 500 })
    ]);
    const response = await handleDeleteAccountRequest(request(), env, fetcher);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Could not remove account data. Please retry.' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('cleans up through the caller JWT before deleting only that auth user', async () => {
    const fetcher = fetchSequence([
      Response.json({ id: 'user-123', is_anonymous: false }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 })
    ]);
    const response = await handleDeleteAccountRequest(request(), env, fetcher);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'Account deleted' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1][0].toString()).toBe(
      'https://project.supabase.co/rest/v1/rpc/delete_account_data'
    );
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe('Bearer service-role-key');
    expect(fetcher.mock.calls[1][1].body).toBe(JSON.stringify({ p_user_id: 'user-123' }));
    expect(fetcher.mock.calls[2][0].toString()).toBe(
      'https://project.supabase.co/auth/v1/admin/users/user-123'
    );
    expect(fetcher.mock.calls[2][1].headers.Authorization).toBe('Bearer service-role-key');
  });

  it('reports incomplete account deletion when the auth admin request fails', async () => {
    const fetcher = fetchSequence([
      Response.json({ id: 'user-123', is_anonymous: false }),
      new Response(null, { status: 204 }),
      new Response('', { status: 500 })
    ]);
    const response = await handleDeleteAccountRequest(request(), env, fetcher);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'Account data was removed, but account deletion did not finish. Please retry.'
    });
  });

  it('allows only configured origins and methods', async () => {
    const blockedRequest = new Request('https://project.supabase.co/functions/v1/delete-account', {
      method: 'OPTIONS',
      headers: { Origin: 'https://attacker.example' }
    });
    const blocked = await handleDeleteAccountRequest(blockedRequest, env, fetchSequence([]));
    expect(blocked.status).toBe(200);
    expect(blocked.headers.get('Access-Control-Allow-Origin')).toBeNull();

    const get = await handleDeleteAccountRequest(request('GET'), env, fetchSequence([]));
    expect(get.status).toBe(405);
  });
});
