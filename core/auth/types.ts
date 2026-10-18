/**
 * Role-based access control types for Utix
 * 
 * Utix is read-only by design and does not perform privileged operations.
 * These types establish a foundation for future access controls if needed.
 */

export type Role = 'viewer' | 'maintainer' | 'service';

export type Permission =
  | 'view:tools'
  | 'view:dashboard'
  | 'admin:health'
  | 'admin:recovery'
  | 'admin:metrics'
  | 'admin:replay'
  | 'admin:config';

export interface RolePermissions {
  role: Role;
  permissions: Permission[];
}

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  viewer: ['view:tools', 'view:dashboard'],
  maintainer: [
    'view:tools',
    'view:dashboard',
    'admin:health',
    'admin:recovery',
    'admin:metrics',
    'admin:replay',
    'admin:config'
  ],
  service: ['admin:health', 'admin:metrics'],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function hasAnyPermission(role: Role, permissions: Permission[]): boolean {
  return permissions.some(p => hasPermission(role, p));
}

export function hasAllPermissions(role: Role, permissions: Permission[]): boolean {
  return permissions.every(p => hasPermission(role, p));
}
