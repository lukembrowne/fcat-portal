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
import {
  addUser,
  removeUser,
  setPermission,
  removePermission,
  syncAllowedEmails,
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

interface AdminClientProps {
  users: UserWithPermissions[];
  projects: Project[];
}

const ROLES = [
  { value: "viewer", label: "Visor" },
  { value: "editor", label: "Editor" },
  { value: "admin", label: "Admin" },
];

export function AdminClient({ users, projects }: AdminClientProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  // Add user form state
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newIsExternal, setNewIsExternal] = useState(false);

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

  const externalCount = users.filter((u) => u.isExternal).length;

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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Correo</TableHead>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Último acceso</TableHead>
                  {projects.map((p) => (
                    <TableHead key={p.id}>{p.name}</TableHead>
                  ))}
                  <TableHead className="w-[80px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.email}>
                    <TableCell className="font-mono text-sm">
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
          )}
        </CardContent>
      </Card>
    </div>
  );
}
