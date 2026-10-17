# Role-Based Access Control

Utix implements a simple role-based access control system to protect privileged operations and administrative endpoints.

## Roles

### Viewer
Default role for all users. Can access all public tools and features.

**Permissions:**
- `view:tools` - Access utility tools
- `view:dashboard` - View dashboard

### Maintainer
Administrative role for project maintainers and operators.

**Permissions:**
- All viewer permissions
- `admin:health` - Access operational health dashboard
- `admin:recovery` - Run disaster recovery validation
- `admin:metrics` - View system metrics
- `admin:replay` - Rebuild, promote and roll back projections (see [EVENT_REPLAY.md](./EVENT_REPLAY.md))

### Service
Limited administrative role for automated services and monitoring systems.

**Permissions:**
- `admin:health` - Access operational health dashboard
- `admin:metrics` - View system metrics

## Server-Side Enforcement

All permission checks are enforced server-side and cannot be bypassed through UI manipulation.

```typescript
import { requirePermission, getAuthContext } from '@/core/auth/middleware';

export async function adminAction() {
  const context = getAuthContext();
  requirePermission(context, 'admin:health');
  
  // Privileged operation here
}
```

## Using the Permission Wrapper

For server actions and API routes, use the `withPermission` wrapper:

```typescript
import { withPermission } from '@/core/auth/middleware';

export const protectedAction = withPermission(
  'admin:recovery',
  async (param: string) => {
    // This code only runs if permission is granted
    return performRecoveryValidation(param);
  }
);
```

## Configuration

Set the user role via environment variable:

```bash
UTIX_USER_ROLE=maintainer
```

If not set, defaults to `viewer`.

## Client-Side UI Hints

While security is enforced server-side, the UI can hide or disable unauthorized actions for better UX:

```typescript
import { hasPermission } from '@/core/auth/types';

const canAccessAdmin = hasPermission(userRole, 'admin:health');

{canAccessAdmin && <AdminDashboardLink />}
```

**Important:** UI checks are hints only. Never rely on them for security.

## Testing

All permission combinations are tested in `core/auth/__tests__/permissions.test.ts`. Every privileged action must have corresponding permission tests.

## Future Extensions

When adding new privileged operations:

1. Define the permission in `core/auth/types.ts`
2. Add it to the appropriate role in `ROLE_PERMISSIONS`
3. Protect the handler with `requirePermission` or `withPermission`
4. Add test coverage for the permission check
5. Update this documentation
