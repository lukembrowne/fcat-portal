// Auth types
export type ProjectRole = "viewer" | "editor" | "admin";
export type GlobalRole = "super_admin" | null;

export interface UserPermission {
  projectId: string;
  role: ProjectRole;
}

export interface AuthUser {
  email: string;
  name: string | null;
  isExternal: boolean;
  globalRole: GlobalRole;
  permissions: UserPermission[];
}

// Action result types (discriminated union)
export interface ActionSuccess<T = void> {
  success: true;
  data: T;
}

export interface ActionError {
  success: false;
  error: string;
}

export type ActionResult<T = void> = ActionSuccess<T> | ActionError;

// Verification stats
export interface VerificationStats {
  total: number;
  verified: number;
  rejected: number;
  corrected: number;
  unverified: number;
}
