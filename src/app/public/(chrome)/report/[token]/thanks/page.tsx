import type { Metadata } from "next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Report Submitted — FCAT",
};

export default function ReportThanksPage() {
  return (
    <Card className="max-w-lg mx-auto">
      <CardHeader>
        <CardTitle>Report Submitted</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p>
          Thank you for submitting your final report. The FCAT team will review
          your submission.
        </p>
        <p className="text-sm text-muted-foreground">
          A confirmation email has been sent to the address on file. If you have
          any questions, please contact Luis Carrasco at{" "}
          <a href="mailto:luis.carrasco@fcat-ecuador.org" className="underline">
            luis.carrasco@fcat-ecuador.org
          </a>.
        </p>
      </CardContent>
    </Card>
  );
}
