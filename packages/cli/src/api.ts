/** Small client for the Zyrox admin API. */
export class Api {
  constructor(
    readonly server: string,
    private readonly token?: string,
  ) {}

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.server.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const error = new ApiError(data?.error?.message ?? `HTTP ${res.status}`, res.status, data?.error);
      throw error;
    }
    return data as T;
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: { code?: string; details?: unknown },
  ) {
    super(message);
  }
}
