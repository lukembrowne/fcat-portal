import type { Metadata } from "next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Application Submitted — FCAT",
};

export default async function ThanksPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string }>;
}) {
  const { ref } = await searchParams;

  return (
    <Card className="max-w-lg mx-auto">
      <CardHeader>
        <CardTitle>Application Submitted</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p>
          Thank you for submitting your research application. The FCAT Scientific
          Committee will review your application and notify you of their decision.
        </p>

        {ref && (
          <div className="rounded-md bg-muted px-4 py-3">
            <p className="text-sm text-muted-foreground">Your reference code:</p>
            <p className="text-lg font-mono font-bold">{ref}</p>
          </div>
        )}

        <p className="text-sm text-muted-foreground">
          A confirmation email has been sent to the email address you provided.
          Please keep your reference code for future correspondence.
        </p>
      </CardContent>
    </Card>
  );
}
