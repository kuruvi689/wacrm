export const PLATFORM_ADMIN_EMAIL =
  process.env.NEXT_PUBLIC_PLATFORM_ADMIN_EMAIL ||
  process.env.PLATFORM_ADMIN_EMAIL ||
  'ssivanesh544@gmail.com';

/**
 * Checks whether the provided email belongs to the Platform Admin / Super Admin (ssivanesh544@gmail.com).
 * Supported on both client and server runtime environments.
 */
export const isPlatformAdmin = (email?: string | null): boolean => {
  if (!email) return false;
  return email.trim().toLowerCase() === PLATFORM_ADMIN_EMAIL.trim().toLowerCase();
};
