import type { Metadata } from "next";
import { ApplyForm } from "./apply-form";

export const metadata: Metadata = {
  title: "Research Project Application — FCAT",
  description:
    "Apply to conduct field research at the FCAT Reserve in northwest Ecuador.",
};

export default function ApplyPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">
          FCAT Research Project Application
        </h1>
        <p className="text-muted-foreground mt-1">
          To conduct research at FCAT facilities, all researchers must submit a
          formal application and receive approval from the FCAT Scientific
          Committee. This process ensures that all research projects align with
          FCAT&apos;s mission, values, and scientific priorities, and that they
          comply with relevant regulations and ethical guidelines. Please allow
          at least one month for review of the application prior to the proposed
          start date at FCAT.
        </p>
      </div>

      <ApplyForm />
    </div>
  );
}
