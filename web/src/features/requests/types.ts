export interface RequestPermissions {
  isSuper: boolean;
  isAdmin: boolean;
  canEdit: boolean;
  guest: boolean;
}

export interface EditorRequest {
  mode: "create" | "edit" | "archive";
  id?: number;
}
