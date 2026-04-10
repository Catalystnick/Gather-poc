import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set in .env.local",
  );
}

// Log callback shape without leaking raw tokens from URL hash/query.
const currentPath = `${window.location.origin}${window.location.pathname}`;
const queryParams = new URLSearchParams(window.location.search);
const hashParams = new URLSearchParams(
  window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash,
);
console.log("hashparams", hashParams);
const hasCode = queryParams.has("code");
const hasHashSessionParams =
  hashParams.has("access_token") || hashParams.has("refresh_token");
console.log(
  "[supabase] init | path:",
  currentPath,
  "| hasCode:",
  hasCode,
  "| hasHashSessionParams:",
  hasHashSessionParams,
);

// Single client instance — ES module cache guarantees this is never re-created.
// detectSessionInUrl: true (default) — SDK auto-exchanges the ?code= param on the
// /auth/callback route before onAuthStateChange fires SIGNED_IN.
// persistSession: true (default) — session written to localStorage, restored on reload.
// autoRefreshToken: true (default) — SDK refreshes silently before expiry.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    flowType: "pkce",
    detectSessionInUrl: true,
    persistSession: true,
    autoRefreshToken: true,
  },
});
