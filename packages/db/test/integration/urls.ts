export interface RoleCreds {
  name: string;
  password: string;
}
export interface ItContext {
  adminUrl: string;
  suffix: string;
  template: string;
  roles: { owner: RoleCreds; writer: RoleCreds; reader: RoleCreds };
}

export function urlFor(adminUrl: string, role: RoleCreds, database: string): string {
  const u = new URL(adminUrl);
  u.username = encodeURIComponent(role.name);
  u.password = encodeURIComponent(role.password);
  u.pathname = `/${database}`;
  return u.toString();
}
