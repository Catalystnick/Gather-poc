import { TenantServiceError } from "./errors.js";

function getSupabaseConfig() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Validate lazily so non-tenant server paths can still boot without tenant env vars.
  if (!supabaseUrl) {
    throw new TenantServiceError("SUPABASE_URL is required", {
      status: 503,
      code: "supabase_url_missing",
    });
  }
  if (!serviceRoleKey) {
    throw new TenantServiceError(
      "SUPABASE_SERVICE_ROLE_KEY is required for tenant APIs",
      {
        status: 503,
        code: "supabase_service_key_missing",
      },
    );
  }
  return {
    restBaseUrl: `${supabaseUrl}/rest/v1`,
    serviceRoleKey,
  };
}

function makeUrl(baseUrl, path, query) {
  const url = new URL(`${baseUrl}/${path}`);
  if (!query) return url;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function readJsonOrText(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function supabaseRestRequest({
  path,
  method = "GET",
  query,
  body,
  schema = "public",
  prefer,
}) {
  const { restBaseUrl, serviceRoleKey } = getSupabaseConfig();
  const url = makeUrl(restBaseUrl, path, query);
  // Service-role calls intentionally bypass client RLS for trusted backend operations.
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "Accept-Profile": schema,
    "Content-Profile": schema,
  };
  if (prefer) headers.Prefer = prefer;

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await readJsonOrText(response);
  console.log("payload inside spabase rest", payload);
  if (response.ok) return payload;

  throw new TenantServiceError("Supabase REST request failed", {
    status:
      response.status >= 400 && response.status < 600 ? response.status : 500,
    code: "supabase_rest_error",
    details: {
      method,
      path,
      query,
      payload,
    },
  });
}
