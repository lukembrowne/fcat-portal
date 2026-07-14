import type { Metadata } from "next";
import { validateReportToken } from "./actions";
import { ReportForm } from "./report-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ReissueForm } from "./reissue-form";

export const metadata: Metadata = {
  title: "Submit Final Report — FCAT",
};

export default async function ReportPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await validateReportToken(token);

  if (!result) {
    return (
      <Card className="max-w-lg mx-auto">
        <CardHeader>
          <CardTitle>Invalid or Expired Link</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p>
            This report submission link is invalid or has expired. If you need to
            submit your final report, enter your email below and we will send you
            a new link.
          </p>
          <ReissueForm />
        </CardContent>
      </Card>
    );
  }

  if (result.hasReport) {
    return (
      <Card className="max-w-lg mx-auto">
        <CardHeader>
          <CardTitle>Report Already Submitted</CardTitle>
        </CardHeader>
        <CardContent>
          <p>
            A final report has already been submitted for{" "}
            <strong>{result.app.projectTitle}</strong> (
            {result.app.referenceCode}). If you need to make changes, please
            contact FCAT directly.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Submit Final Report</h1>
        <p className="text-muted-foreground mt-1">
          Project: <strong>{result.app.projectTitle}</strong>
          {result.app.referenceCode && ` (${result.app.referenceCode})`}
        </p>
      </div>

      <ReportForm token={token} app={result.app} />
    </div>
  );
}
