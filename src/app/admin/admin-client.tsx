"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import {
  addUser,
  removeUser,
  setPermission,
  removePermission,
  syncAllowedEmails,
  createCameraTrapProject,
  updateCameraTrapProject,
  deleteCameraTrapProject,
  setCameraTrapProjectAccess,
} from "./actions";

interface UserWithPermissions {
  email: string;
  name: string | null;
  isExternal: boolean;
  globalRole: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  permissions: { projectId: string; role: string }[];
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "hace un momento";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `hace ${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `hace ${months} mes${months > 1 ? "es" : ""}`;
  const years = Math.floor(days / 365);
  return `hace ${years} año${years > 1 ? "s" : ""}`;
}

interface Project {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
}

interface CameraTrapProject {
  id: number;
  name: string;
  driveFolderId: string | null;
  createdAt: Date;
}

interface AdminClientProps {
  users: UserWithPermissions[];
  projects: Project[];
  ctProjects: CameraTrapProject[];
  ctAccess: Record<string, number[]>;
}

const ROLES = [
  { value: "viewer", label: "Visor", description: "Solo lectura — puede ver datos del proyecto" },
  { value: "editor", label: "Editor", description: "Puede ver y modificar datos del proyecto" },
  { value: "admin", label: "Admin", description: "Control total — puede gestionar configuración del proyecto" },
];

export function AdminClient({ users, projects, ctProjects, ctAccess }: AdminClientProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  // Add user form state
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newIsExternal, setNewIsExternal] = useState(false);

  // CT project form state
  const [ctDialogOpen, setCtDialogOpen] = useState(false);
  const [ctName, setCtName] = useState("");
  const [ctDriveFolderId, setCtDriveFolderId] = useState("");
  const [editingCtProject, setEditingCtProject] = useState<CameraTrapProject | null>(null);

  const handleAddUser = () => {
    startTransition(async () => {
      const result = await addUser(newEmail, newName || null, newIsExternal);
      if (result.success) {
        setAddDialogOpen(false);
        setNewEmail("");
        setNewName("");
        setNewIsExternal(false);
        router.refresh();
      } else {
        alert(result.error);
      }
    });
  };

  const handleRemoveUser = (email: string) => {
    if (!confirm(`¿Eliminar el usuario ${email}? Esta acción no se puede deshacer.`)) {
      return;
    }
    startTransition(async () => {
      const result = await removeUser(email);
      if (result.success) {
        router.refresh();
      } else {
        alert(result.error);
      }
    });
  };

  const handleSetPermission = (email: string, projectId: string, role: string) => {
    startTransition(async () => {
      const result = await setPermission(email, projectId, role);
      if (result.success) {
        router.refresh();
      } else {
        alert(result.error);
      }
    });
  };

  const handleRemovePermission = (email: string, projectId: string) => {
    startTransition(async () => {
      const result = await removePermission(email, projectId);
      if (result.success) {
        router.refresh();
      } else {
        alert(result.error);
      }
    });
  };

  const handleSyncEmails = () => {
    startTransition(async () => {
      const result = await syncAllowedEmails();
      if (result.success) {
        alert(`Se sincronizaron ${result.data.count} correos externos.`);
      } else {
        alert(result.error);
      }
    });
  };

  // CT project handlers
  const handleCreateCtProject = () => {
    startTransition(async () => {
      const result = await createCameraTrapProject(ctName, ctDriveFolderId || undefined);
      if (result.success) {
        setCtDialogOpen(false);
        setCtName("");
        setCtDriveFolderId("");
        router.refresh();
      } else {
        alert(result.error);
      }
    });
  };

  const handleUpdateCtProject = () => {
    if (!editingCtProject) return;
    startTransition(async () => {
      const result = await updateCameraTrapProject(editingCtProject.id, {
        name: ctName,
        driveFolderId: ctDriveFolderId || null,
      });
      if (result.success) {
        setEditingCtProject(null);
        setCtName("");
        setCtDriveFolderId("");
        router.refresh();
      } else {
        alert(result.error);
      }
    });
  };

  const handleDeleteCtProject = (id: number, name: string) => {
    if (!confirm(`¿Eliminar el proyecto "${name}"? Esta acción no se puede deshacer.`)) return;
    startTransition(async () => {
      const result = await deleteCameraTrapProject(id);
      if (!result.success) {
        alert(result.error);
      } else {
        router.refresh();
      }
    });
  };

  const handleToggleCtAccess = (email: string, projectId: number, currentlyHasAccess: boolean) => {
    const currentIds = ctAccess[email] || [];
    const newIds = currentlyHasAccess
      ? currentIds.filter((id) => id !== projectId)
      : [...currentIds, projectId];

    startTransition(async () => {
      const result = await setCameraTrapProjectAccess(email, newIds);
      if (result.success) {
        router.refresh();
      } else {
        alert(result.error);
      }
    });
  };

  const externalCount = users.filter((u) => u.isExternal).length;

  // Users who have camera-trap module access (for CT project assignment)
  const cameraTrapUsers = users.filter(
    (u) => u.globalRole === "super_admin" || u.permissions.some((p) => p.projectId === "camera-trap")
  );

  return (
    <div className="space-y-6">
      {/* Stats + Actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Badge variant="secondary" className="text-sm">
            {users.length} usuarios
          </Badge>
          {externalCount > 0 && (
            <Badge variant="outline" className="text-sm">
              {externalCount} externos
            </Badge>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleSyncEmails} disabled={isPending}>
            Sincronizar Lista de Correos
          </Button>
          <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm">Agregar Usuario</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Agregar Usuario</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div>
                  <Label htmlFor="email">Correo electrónico</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="usuario@ejemplo.com"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="name">Nombre (opcional)</Label>
                  <Input
                    id="name"
                    placeholder="Juan Pérez"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                </div>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newIsExternal}
                    onChange={(e) => setNewIsExternal(e.target.checked)}
                    className="accent-primary"
                  />
                  Usuario externo (colaborador)
                </label>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAddDialogOpen(false)}>
                  Cancelar
                </Button>
                <Button onClick={handleAddUser} disabled={isPending || !newEmail.trim()}>
                  {isPending ? "Agregando..." : "Agregar"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Role Legend */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="font-medium">Roles:</span>
        {ROLES.map((r) => (
          <span key={r.value}>
            <span className="font-medium">{r.label}</span> — {r.description}
          </span>
        ))}
      </div>

      {/* Users Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Usuarios</CardTitle>
        </CardHeader>
        <CardContent>
          {users.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-4">
              No hay usuarios registrados.
            </p>
          ) : (
            <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 z-10 bg-background after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-border">Correo</TableHead>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Último acceso</TableHead>
                  {projects.map((p) => (
                    <TableHead key={p.id} className="whitespace-nowrap">{p.name}</TableHead>
                  ))}
                  <TableHead className="w-[80px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.email}>
                    <TableCell className="font-mono text-sm sticky left-0 z-10 bg-background after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-border">
                      <div className="flex items-center gap-2">
                        {user.email}
                        {user.globalRole === "super_admin" && (
                          <Badge className="bg-purple-600 text-xs">Super Admin</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{user.name || "—"}</TableCell>
                    <TableCell>
                      {user.isExternal ? (
                        <Badge variant="outline" className="text-xs">Externo</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">FCAT</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {user.lastSeenAt ? timeAgo(user.lastSeenAt) : "—"}
                    </TableCell>
                    {projects.map((project) => {
                      const perm = user.permissions.find(
                        (p) => p.projectId === project.id
                      );
                      return (
                        <TableCell key={project.id}>
                          <div className="flex items-center gap-1">
                            <Select
                              value={perm?.role || "none"}
                              onValueChange={(value) => {
                                if (value === "none") {
                                  handleRemovePermission(user.email, project.id);
                                } else {
                                  handleSetPermission(user.email, project.id, value);
                                }
                              }}
                            >
                              <SelectTrigger className="h-8 w-[110px] text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">Sin acceso</SelectItem>
                                {ROLES.map((r) => (
                                  <SelectItem key={r.value} value={r.value}>
                                    {r.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </TableCell>
                      );
                    })}
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => handleRemoveUser(user.email)}
                        disabled={isPending}
                      >
                        Eliminar
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Camera Trap Projects */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Proyectos de Cámaras Trampa</CardTitle>
            <Dialog open={ctDialogOpen} onOpenChange={(open) => {
              setCtDialogOpen(open);
              if (!open) { setCtName(""); setCtDriveFolderId(""); }
            }}>
              <DialogTrigger asChild>
                <Button size="sm">Agregar Proyecto</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Agregar Proyecto</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-2">
                  <div>
                    <Label htmlFor="ct-name">Nombre</Label>
                    <Input
                      id="ct-name"
                      placeholder="Ej: Canande"
                      value={ctName}
                      onChange={(e) => setCtName(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="ct-drive">ID de Carpeta Drive (opcional)</Label>
                    <Input
                      id="ct-drive"
                      placeholder="Ej: 1-oYvxb...fgqo"
                      value={ctDriveFolderId}
                      onChange={(e) => setCtDriveFolderId(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      El ID está en la URL de la carpeta de Google Drive.
                    </p>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setCtDialogOpen(false)}>
                    Cancelar
                  </Button>
                  <Button onClick={handleCreateCtProject} disabled={isPending || !ctName.trim()}>
                    {isPending ? "Creando..." : "Crear"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Project list */}
          {ctProjects.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-4">
              No hay proyectos configurados.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Carpeta Drive</TableHead>
                  <TableHead className="w-[120px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {ctProjects.map((proj) => (
                  <TableRow key={proj.id}>
                    <TableCell className="font-medium">{proj.name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {proj.driveFolderId
                        ? proj.driveFolderId.length > 20
                          ? `${proj.driveFolderId.slice(0, 20)}...`
                          : proj.driveFolderId
                        : "(sin configurar)"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex gap-1 justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditingCtProject(proj);
                            setCtName(proj.name);
                            setCtDriveFolderId(proj.driveFolderId || "");
                          }}
                          disabled={isPending}
                        >
                          Editar
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => handleDeleteCtProject(proj.id, proj.name)}
                          disabled={isPending}
                        >
                          Eliminar
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {/* Edit project dialog */}
          <Dialog
            open={editingCtProject !== null}
            onOpenChange={(open) => {
              if (!open) { setEditingCtProject(null); setCtName(""); setCtDriveFolderId(""); }
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Editar Proyecto</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div>
                  <Label htmlFor="ct-edit-name">Nombre</Label>
                  <Input
                    id="ct-edit-name"
                    value={ctName}
                    onChange={(e) => setCtName(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="ct-edit-drive">ID de Carpeta Drive</Label>
                  <Input
                    id="ct-edit-drive"
                    placeholder="Ej: 1-oYvxb...fgqo"
                    value={ctDriveFolderId}
                    onChange={(e) => setCtDriveFolderId(e.target.value)}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setEditingCtProject(null)}>
                  Cancelar
                </Button>
                <Button onClick={handleUpdateCtProject} disabled={isPending || !ctName.trim()}>
                  {isPending ? "Guardando..." : "Guardar"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* User ↔ CT project access matrix */}
          {ctProjects.length > 0 && cameraTrapUsers.length > 0 && (
            <div>
              <h3 className="text-sm font-medium mb-3">Acceso por usuario</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Usuario</TableHead>
                    {ctProjects.map((proj) => (
                      <TableHead key={proj.id} className="text-center">
                        {proj.name}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cameraTrapUsers.map((user) => {
                    const userAccessIds = ctAccess[user.email] || [];
                    const isSuperAdmin = user.globalRole === "super_admin";
                    return (
                      <TableRow key={user.email}>
                        <TableCell className="font-mono text-sm">
                          {user.email}
                          {isSuperAdmin && (
                            <span className="text-xs text-muted-foreground ml-2">(todos)</span>
                          )}
                        </TableCell>
                        {ctProjects.map((proj) => {
                          const hasAccess = userAccessIds.includes(proj.id);
                          return (
                            <TableCell key={proj.id} className="text-center">
                              {isSuperAdmin ? (
                                <Checkbox checked disabled className="opacity-50" />
                              ) : (
                                <Checkbox
                                  checked={hasAccess}
                                  onCheckedChange={() =>
                                    handleToggleCtAccess(user.email, proj.id, hasAccess)
                                  }
                                  disabled={isPending}
                                />
                              )}
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
