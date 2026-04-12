"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { reissueReportToken } from "./actions";

export function ReissueForm() {
  const [isPending, startTransition] = useTransition();
  const [sent, setSent] = useState(false);
  const [email, setEmail] = useState("");

  function handleSubmit() {
    if (!email.trim()) return;

    startTransition(async () => {
      await reissueReportToken(email);
      setSent(true);
    });
  }

  if (sent) {
    return (
      <p className="text-sm text-muted-foreground">
        If your email matches an accepted application with a pending report, a
        new link has been sent. Please check your inbox.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="email">Your Email Address</Label>
        <Input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="researcher@university.edu"
        />
      </div>
      <Button onClick={handleSubmit} disabled={isPending || !email.trim()}>
        {isPending ? "Sending..." : "Request New Link"}
      </Button>
    </div>
  );
}
