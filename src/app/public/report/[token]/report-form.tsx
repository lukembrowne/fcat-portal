"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FileDropzone } from "@/components/file-dropzone";
import { submitFinalReport } from "./actions";
import type { ResearchApplication } from "@/db/schema";

interface ReportFormProps {
  token: string;
  app: ResearchApplication;
}

export function ReportForm({ token, app }: ReportFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reportFiles, setReportFiles] = useState<File[]>([]);

  function handleSubmit() {
    setError(null);

    startTransition(async () => {
      const fd = new FormData();

      for (const file of reportFiles) {
        fd.append("reportFiles", file);
      }

      const result = await submitFinalReport(fd, token);

      if (result.success) {
        router.push(`/public/report/${token}/thanks`);
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Final Report</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Application summary */}
        <div className="rounded-lg bg-muted/50 p-4 text-sm space-y-1">
          <p>
            <strong>Researcher:</strong> {app.piFullName}
          </p>
          <p>
            <strong>Institution:</strong> {app.piInstitution ?? "—"}
          </p>
          <p>
            <strong>Period:</strong> {app.projectStartDate} — {app.projectEndDate}
          </p>
        </div>

        <div className="text-sm text-muted-foreground space-y-2">
          <p>
            Within 3 months of completion of their research, researchers should
            provide FCAT with a final report summarizing their methods, results,
            and conclusions. This report should be written in a format that is
            accessible to a general audience. When possible, researchers should
            provide copies of publications in both English and Spanish.
          </p>
        </div>

        <FileDropzone
          id="reportFiles"
          files={reportFiles}
          onChange={setReportFiles}
          label="Report Documents (PDF, JPEG, PNG — max 10 MB each, 25 MB total) *"
          hint="Upload your final report and any supporting materials such as publications, data summaries, or presentations."
        />

        {error && (
          <div className="rounded-md bg-destructive/10 text-destructive px-4 py-3 text-sm">
            {error}
          </div>
        )}

        <Button onClick={handleSubmit} disabled={isPending}>
          {isPending ? "Submitting..." : "Submit Final Report"}
        </Button>
      </CardContent>
    </Card>
  );
}
