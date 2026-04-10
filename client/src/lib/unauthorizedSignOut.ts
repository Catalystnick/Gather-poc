import { supabase } from "./supabase";

let signOutRequest: Promise<void> | null = null;
const UNAUTHORIZED_REASON_MARKERS = [
  "unauthorized",
  "not authenticated",
  "invalid or expired token",
  "user account no longer exists",
  "invalid_token",
  "token_invalid",
  "token_missing",
  "token_subject_mismatch",
  "user_deleted",
];

function beginSignOut() {
  if (signOutRequest) return signOutRequest;
  signOutRequest = supabase.auth
    .signOut()
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      signOutRequest = null;
    });
  return signOutRequest;
}

export function hasUnauthorizedStatus(status: number) {
  return status === 401;
}

export async function signOutIfUnauthorizedStatus(status: number) {
  if (!hasUnauthorizedStatus(status)) return;
  await beginSignOut();
}

export function hasUnauthorizedReason(reason: string) {
  const normalizedReason = reason.trim().toLowerCase();
  if (!normalizedReason) return false;
  return UNAUTHORIZED_REASON_MARKERS.some((marker) =>
    normalizedReason.includes(marker),
  );
}

export async function signOutIfUnauthorizedReason(reason: string) {
  if (!hasUnauthorizedReason(reason)) return;
  await beginSignOut();
}
