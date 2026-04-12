"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  STATUS_LABELS,
  getValidTransitions,
} from "@/lib/research-applications/transitions";
import type { ResearchApplicationStatus } from "@/db/schema";
import type { ApplicationDetail } from "./actions";
import {
  updateApplicationStatus,
  setPrimaryReviewer,
  setFinalReportDueDate,
  addComment,
  generateReportLink,
  resendReportLink,
  deleteApplication,
} from "./actions";

const STATUS_COLORS: Record<string, string> = {
  submitted: "bg-blue-100 text-blue-800",
  under_review: "bg-yellow-100 text-yellow-800",
  accepted: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
  revisions_requested: "bg-orange-100 text-orange-800",
};

const ALL_STATUSES: ResearchApplicationStatus[] = [
  "submitted",
  "under_review",
  "accepted",
  "rejected",
  "revisions_requested",
];

const STATUS_BORDER_COLORS: Record<string, string> = {
  submitted: "border-blue-300 bg-blue-50",
  under_review: "border-yellow-300 bg-yellow-50",
  accepted: "border-green-300 bg-green-50",
  rejected: "border-red-300 bg-red-50",
  revisions_requested: "border-orange-300 bg-orange-50",
};

const STATUS_RADIO_COLORS: Record<string, string> = {
  submitted: "border-blue-500",
  under_review: "border-yellow-500",
  accepted: "border-green-600",
  rejected: "border-red-500",
  revisions_requested: "border-orange-500",
};

const STATUS_DOT_COLORS: Record<string, string> = {
  submitted: "bg-blue-500",
  under_review: "bg-yellow-500",
  accepted: "bg-green-600",
  rejected: "bg-red-500",
  revisions_requested: "bg-orange-500",
};

interface DetailClientProps {
  app: ApplicationDetail;
  isEditor: boolean;
}

export function DetailClient({ app, isEditor }: DetailClientProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [statusNotes, setStatusNotes] = useState("");
  const [selectedStatus, setSelectedStatus] = useState<ResearchApplicationStatus>(app.status);
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://portal.fcat-ecuador.org";
  const [reportLinkUrl, setReportLinkUrl] = useState<string | null>(
    app.reportSubmitToken
      ? `${siteUrl}/public/report/${app.reportSubmitToken}`
      : null
  );
  const [linkCopied, setLinkCopied] = useState(false);
  const [linkEmailSent, setLinkEmailSent] = useState(false);

  const validTransitions = getValidTransitions(app.status);
  const driveFiles = app.driveFilesJson
    ? (JSON.parse(app.driveFilesJson) as Array<{ id: string; name: string; mimeType: string; size: number; category?: string }>)
    : [];
  const permitFiles = driveFiles.filter((f) => f.category === "permit");
  const supportingFiles = driveFiles.filter((f) => f.category !== "permit");

  function handleStatusChange(newStatus: ResearchApplicationStatus) {
    setError(null);
    startTransition(async () => {
      const result = await updateApplicationStatus(app.id, newStatus, statusNotes || null);
      if (!result.success) setError(result.error);
      else setStatusNotes("");
    });
  }

  function handleSetReviewer(formData: FormData) {
    const email = formData.get("reviewerEmail");
    if (typeof email !== "string" || !email) return;
    startTransition(async () => {
      const result = await setPrimaryReviewer(app.id, email);
      if (!result.success) setError(result.error);
    });
  }

  function handleSetDueDate(formData: FormData) {
    const date = formData.get("dueDate");
    if (typeof date !== "string" || !date) return;
    startTransition(async () => {
      const result = await setFinalReportDueDate(app.id, date);
      if (!result.success) setError(result.error);
    });
  }

  function handleAddComment() {
    if (!commentText.trim()) return;
    setError(null);
    startTransition(async () => {
      const result = await addComment(app.id, commentText);
      if (result.success) setCommentText("");
      else setError(result.error);
    });
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground font-mono">
            {app.referenceCode}
          </p>
          <h1 className="text-2xl font-bold">{app.projectTitle}</h1>
          <p className="text-muted-foreground">
            {app.piFullName}
            {app.piInstitution && ` — ${app.piInstitution}`}
          </p>
        </div>
        <Badge
          variant="secondary"
          className={`text-sm ${STATUS_COLORS[app.status] ?? ""}`}
        >
          {STATUS_LABELS[app.status]}
        </Badge>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 text-destructive px-4 py-3 text-sm">
          {error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main content — 2 cols */}
        <div className="lg:col-span-2 space-y-6">
          {/* Reports — shown at top when they exist */}
          {app.reports.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Informe Final</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {app.reports.map((report) => {
                  const reportFiles = report.driveFilesJson
                    ? (JSON.parse(report.driveFilesJson) as Array<{ id: string; name: string; size: number }>)
                    : [];
                  return (
                    <div key={report.id} className="space-y-2">
                      {report.summary && (
                        <p className="text-sm">{report.summary}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Entregado:{" "}
                        {report.submittedAt.toLocaleDateString("es-EC")}
                      </p>
                      {reportFiles.map((f) => (
                        <div
                          key={f.id}
                          className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                        >
                          <span className="flex-1 truncate">{f.name}</span>
                          <a
                            href={`https://drive.google.com/file/d/${f.id}/view`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-primary hover:underline whitespace-nowrap"
                          >
                            Abrir en Drive
                          </a>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {/* Detalles */}
          <Card>
            <CardHeader>
              <CardTitle>Detalles del Proyecto</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <DetailField label="Email" value={app.piEmail} />
              <DetailField label="Teléfono" value={app.piPhone} />
              <DetailField label="Colaboradores" value={app.collaborators} />
              <DetailField
                label="Fechas"
                value={
                  app.projectStartDate && app.projectEndDate
                    ? `${app.projectStartDate} — ${app.projectEndDate}`
                    : null
                }
              />
              <DetailField label="Objetivos" value={app.projectGoals} long />
              <DetailField label="Métodos" value={app.methods} long />
              <DetailField
                label="Muestras"
                value={app.samplesDetails}
                long
              />
              <DetailField
                label="Recursos Genéticos"
                value={app.geneticResources}
                long
              />
              <DetailField
                label="Necesita asistencia de FCAT"
                value={app.needsFcatAssistance ? "Sí" : "No"}
              />
              <DetailField
                label="Uso de instalaciones"
                value={app.facilitiesNeeds}
                long
              />
              <DetailField
                label="Equipo permanente"
                value={app.permanentEquipment}
                long
              />
              <DetailField
                label="Personal y colaboración"
                value={app.personnelCollaboration}
                long
              />
              <DetailField
                label="Compromiso comunitario"
                value={app.communityEngagement}
                long
              />
              <DetailField
                label="Compartir datos"
                value={app.dataSharing}
                long
              />
              <DetailField label="Permisos" value={app.permitsStatus} long />
            </CardContent>
          </Card>

          {/* References */}
          {app.references.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Referencias</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-3 sm:grid-cols-3">
                  {app.references.map((ref) => (
                    <div
                      key={ref.id}
                      className="rounded-lg bg-muted/50 p-3 text-sm"
                    >
                      <div className="font-medium">{ref.name}</div>
                      {ref.email && (
                        <div className="text-muted-foreground">{ref.email}</div>
                      )}
                      {ref.phone && (
                        <div className="text-muted-foreground">{ref.phone}</div>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

        </div>

        {/* Sidebar — 1 col */}
        <div className="space-y-6">
          {/* Review panel */}
          {isEditor && (
            <Card>
              <CardHeader>
                <CardTitle>Revisión</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Status selector */}
                <div className="space-y-3">
                  <Label>Estado</Label>
                  <div className="space-y-1">
                    {ALL_STATUSES.map((status) => {
                      const isCurrent = status === app.status;
                      const isSelected = status === selectedStatus;
                      const isValid = validTransitions.includes(status) || isCurrent;
                      return (
                        <label
                          key={status}
                          className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
                            isSelected
                              ? STATUS_BORDER_COLORS[status]
                              : "border-transparent"
                          } ${
                            isValid
                              ? "opacity-100 hover:bg-muted/50"
                              : "opacity-40 cursor-not-allowed"
                          }`}
                        >
                          <input
                            type="radio"
                            name="status"
                            value={status}
                            checked={isSelected}
                            onChange={() => isValid && setSelectedStatus(status)}
                            disabled={!isValid}
                            className="sr-only"
                          />
                          <span
                            className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                              isSelected
                                ? STATUS_RADIO_COLORS[status]
                                : "border-muted-foreground/30"
                            }`}
                          >
                            {isSelected && (
                              <span
                                className={`h-2 w-2 rounded-full ${STATUS_DOT_COLORS[status]}`}
                              />
                            )}
                          </span>
                          <span className="flex-1 text-sm font-medium">
                            {STATUS_LABELS[status]}
                          </span>
                          {isCurrent && (
                            <span className="text-xs text-muted-foreground">
                              actual
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>

                  {selectedStatus !== app.status && (
                    <div className="space-y-2 pt-2 border-t">
                      <Textarea
                        value={statusNotes}
                        onChange={(e) => setStatusNotes(e.target.value)}
                        placeholder="Notas de decisión (opcional)..."
                        rows={2}
                      />
                      <p className="text-xs text-muted-foreground">
                        {["accepted", "rejected", "revisions_requested"].includes(selectedStatus)
                          ? "Se enviará un email de notificación al investigador."
                          : ""}
                      </p>
                      <Button
                        size="sm"
                        className="w-full"
                        onClick={() => {
                          const label = STATUS_LABELS[selectedStatus];
                          const emailWarning = ["accepted", "rejected", "revisions_requested"].includes(selectedStatus)
                            ? "\n\nSe enviará un email de notificación al investigador."
                            : "";
                          if (
                            confirm(
                              `¿Cambiar estado a "${label}"?${emailWarning}`
                            )
                          ) {
                            handleStatusChange(selectedStatus);
                          }
                        }}
                        disabled={isPending}
                      >
                        {isPending ? "Guardando..." : `Cambiar a ${STATUS_LABELS[selectedStatus]}`}
                      </Button>
                    </div>
                  )}
                </div>

                {/* Primary reviewer */}
                <form action={handleSetReviewer} className="space-y-2">
                  <Label htmlFor="reviewerEmail">Revisor Principal</Label>
                  <div className="flex gap-2">
                    <Input
                      id="reviewerEmail"
                      name="reviewerEmail"
                      type="email"
                      defaultValue={app.primaryReviewerEmail ?? ""}
                      placeholder="email@fcat-ecuador.org"
                      className="flex-1"
                    />
                    <Button size="sm" type="submit" disabled={isPending}>
                      Guardar
                    </Button>
                  </div>
                </form>

                {/* Final report due date */}
                <form action={handleSetDueDate} className="space-y-2">
                  <Label htmlFor="dueDate">Fecha de Entrega de Informe</Label>
                  <p className="text-xs text-muted-foreground">
                    Fecha límite para que el investigador entregue su informe
                    final. Se enviarán recordatorios automáticos.
                  </p>
                  <div className="flex gap-2">
                    <Input
                      id="dueDate"
                      name="dueDate"
                      type="date"
                      defaultValue={app.finalReportDueDate ?? ""}
                      className="flex-1"
                    />
                    <Button size="sm" type="submit" disabled={isPending}>
                      Guardar
                    </Button>
                  </div>
                </form>

                {/* Report submission link — only for accepted apps without a report */}
                {app.status === "accepted" && app.reports.length === 0 && (
                  <div className="space-y-2 pt-2 border-t">
                    <Label>Enlace de Informe Final</Label>
                    <p className="text-xs text-muted-foreground">
                      Enlace para que el investigador suba su informe.
                      Puede copiar el enlace o reenviarlo por email.
                    </p>

                    {reportLinkUrl ? (
                      <div className="space-y-2">
                        <div className="flex gap-1">
                          <Input
                            value={reportLinkUrl}
                            readOnly
                            className="text-xs font-mono flex-1"
                            onClick={(e) => (e.target as HTMLInputElement).select()}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              navigator.clipboard.writeText(reportLinkUrl);
                              setLinkCopied(true);
                              setTimeout(() => setLinkCopied(false), 2000);
                            }}
                          >
                            {linkCopied ? "Copiado" : "Copiar"}
                          </Button>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full"
                          disabled={isPending || linkEmailSent}
                          onClick={() => {
                            startTransition(async () => {
                              const result = await resendReportLink(app.id);
                              if (result.success) {
                                setLinkEmailSent(true);
                              } else {
                                setError(result.error);
                              }
                            });
                          }}
                        >
                          {linkEmailSent
                            ? `Enviado a ${app.piEmail}`
                            : `Enviar por email a ${app.piEmail}`}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full"
                        disabled={isPending}
                        onClick={() => {
                          startTransition(async () => {
                            const result = await generateReportLink(app.id);
                            if (result.success) {
                              setReportLinkUrl(result.data.url);
                            } else {
                              setError(result.error);
                            }
                          });
                        }}
                      >
                        Generar enlace
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Documents */}
          {driveFiles.length > 0 && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Documentos</CardTitle>
                  {app.driveFolderId && (
                    <a
                      href={`https://drive.google.com/drive/folders/${app.driveFolderId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-primary hover:underline"
                    >
                      Abrir en Drive
                    </a>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {permitFiles.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium text-muted-foreground">Permisos de Investigación</h4>
                    {permitFiles.map((file) => (
                      <div
                        key={file.id}
                        className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                      >
                        <span className="flex-1 truncate">{file.name}</span>
                        <a
                          href={`https://drive.google.com/file/d/${file.id}/view`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline whitespace-nowrap"
                        >
                          Abrir
                        </a>
                      </div>
                    ))}
                  </div>
                )}
                <div className="space-y-2">
                  {permitFiles.length > 0 && (
                    <h4 className="text-sm font-medium text-muted-foreground">Documentos de Apoyo</h4>
                  )}
                  {supportingFiles.map((file) => (
                    <div
                      key={file.id}
                      className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                    >
                      <span className="flex-1 truncate">{file.name}</span>
                      <a
                        href={`https://drive.google.com/file/d/${file.id}/view`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary hover:underline whitespace-nowrap"
                      >
                        Abrir
                      </a>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Comments */}
          <Card>
            <CardHeader>
              <CardTitle>Comentarios</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {app.comments.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Sin comentarios aún.
                </p>
              )}
              {app.comments.map((comment) => (
                <div key={comment.id} className="border-l-2 pl-3 space-y-1">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium">
                      {comment.authorEmail.split("@")[0]}
                    </span>
                    <span>
                      {comment.createdAt.toLocaleString("es-EC")}
                    </span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap">{comment.body}</p>
                </div>
              ))}

              {isEditor && (
                <div className="pt-2 space-y-2">
                  <Textarea
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    placeholder="Agregar un comentario..."
                    rows={3}
                  />
                  <Button
                    size="sm"
                    onClick={handleAddComment}
                    disabled={isPending || !commentText.trim()}
                  >
                    {isPending ? "Enviando..." : "Comentar"}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Info card */}
          <Card>
            <CardHeader>
              <CardTitle>Información</CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-2">
              <InfoRow label="Código" value={app.referenceCode ?? "—"} />
              <InfoRow
                label="Enviada"
                value={app.createdAt.toLocaleDateString("es-EC")}
              />
              {app.decidedAt && (
                <InfoRow
                  label="Decidida"
                  value={app.decidedAt.toLocaleDateString("es-EC")}
                />
              )}
              <InfoRow
                label="Código de Conducta"
                value={app.codeOfConductAgreed ? "Aceptado" : "No"}
              />
              <InfoRow
                label="Guía de Investigadores"
                value={app.guidelinesAgreed ? "Aceptada" : "No"}
              />
            </CardContent>
          </Card>

          {/* Delete */}
          {isEditor && (
            <Button
              variant="destructive"
              size="sm"
              className="w-full"
              disabled={isPending}
              onClick={() => {
                if (!confirm(`¿Eliminar la aplicación ${app.referenceCode ?? `#${app.id}`}? Esta acción no se puede deshacer.`)) return;
                startTransition(async () => {
                  const result = await deleteApplication(app.id);
                  if (result.success) {
                    router.push("/research-applications");
                  } else {
                    setError(result.error);
                  }
                });
              }}
            >
              Eliminar aplicación
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailField({
  label,
  value,
  long,
}: {
  label: string;
  value: string | null | undefined;
  long?: boolean;
}) {
  if (!value) return null;

  return (
    <div>
      <dt className="text-sm font-medium text-muted-foreground">{label}</dt>
      <dd className={`mt-1 ${long ? "whitespace-pre-wrap" : ""}`}>{value}</dd>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
