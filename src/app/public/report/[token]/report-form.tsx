"use client";

import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  const [summary, setSummary] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleSubmit() {
    setError(null);

    startTransition(async () => {
      const fd = new FormData();
      fd.set("summary", summary);

      const files = fileInputRef.current?.files;
      if (files) {
        for (const file of Array.from(files)) {
          fd.append("reportFiles", file);
        }
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

        <div>
          <Label htmlFor="summary">Report Summary</Label>
          <Textarea
            id="summary"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Brief summary of findings and conclusions..."
            rows={6}
          />
        </div>

        <div>
          <Label htmlFor="reportFiles">
            Report Documents (PDF, JPEG, PNG — max 10 MB each) *
          </Label>
          <Input
            id="reportFiles"
            type="file"
            ref={fileInputRef}
            multiple
            accept=".pdf,.jpg,.jpeg,.png"
            className="mt-1"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Upload your final report PDF and any supporting materials.
          </p>
        </div>

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
