"use client";

import { useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Turnstile } from "@marsidev/react-turnstile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FileDropzone } from "@/components/file-dropzone";
import { FORM_STEPS } from "./fields";
import { submitApplication } from "./actions";

const STORAGE_KEY = "fcat-apply-draft";

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground mt-1">{children}</p>;
}

interface Reference {
  name: string;
  email: string;
  phone: string;
}

interface FormState {
  // Step 0
  codeOfConductAgreed: boolean;
  guidelinesAgreed: boolean;
  // Step 1
  piFullName: string;
  piEmail: string;
  piPhone: string;
  piInstitution: string;
  collaborators: string;
  projectTitle: string;
  projectStartDate: string;
  projectEndDate: string;
  // Step 2
  projectGoals: string;
  methods: string;
  samplesDetailsNA: boolean;
  samplesDetails: string;
  geneticResourcesNA: boolean;
  geneticResources: string;
  // Step 3
  needsFcatAssistance: boolean;
  facilitiesNeeds: string;
  permanentEquipmentNA: boolean;
  permanentEquipment: string;
  personnelCollaboration: string;
  communityEngagement: string;
  dataSharing: string;
  permitsStatusNA: boolean;
  permitsStatus: string;
  references: Reference[];
}

const INITIAL_STATE: FormState = {
  codeOfConductAgreed: false,
  guidelinesAgreed: false,
  piFullName: "",
  piEmail: "",
  piPhone: "",
  piInstitution: "",
  collaborators: "",
  projectTitle: "",
  projectStartDate: "",
  projectEndDate: "",
  projectGoals: "",
  methods: "",
  samplesDetailsNA: false,
  samplesDetails: "",
  geneticResourcesNA: false,
  geneticResources: "",
  needsFcatAssistance: false,
  facilitiesNeeds: "",
  permanentEquipmentNA: false,
  permanentEquipment: "",
  personnelCollaboration: "",
  communityEngagement: "",
  dataSharing: "",
  permitsStatusNA: false,
  permitsStatus: "",
  references: [
    { name: "", email: "", phone: "" },
    { name: "", email: "", phone: "" },
    { name: "", email: "", phone: "" },
  ],
};

function loadDraft(): FormState {
  if (typeof window === "undefined") return INITIAL_STATE;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return { ...INITIAL_STATE, ...JSON.parse(saved) };
  } catch {
    // Ignore parse errors
  }
  return INITIAL_STATE;
}

function saveDraft(state: FormState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore quota errors
  }
}

function clearDraft() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore
  }
}

export function ApplyForm() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(loadDraft);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [permitFiles, setPermitFiles] = useState<File[]>([]);
  const [supportingFiles, setSupportingFiles] = useState<File[]>([]);

  // Auto-save to localStorage on changes
  useEffect(() => {
    saveDraft(form);
  }, [form]);

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError(null);
  }

  function updateReference(index: number, field: keyof Reference, value: string) {
    setForm((prev) => {
      const refs = [...prev.references];
      refs[index] = { ...refs[index], [field]: value };
      return { ...prev, references: refs };
    });
  }

  function validateStep(s: number): string | null {
    switch (s) {
      case 0:
        if (!form.codeOfConductAgreed || !form.guidelinesAgreed)
          return "You must agree to both the Code of Conduct and the Researcher Guidelines and Expectations to proceed.";
        break;
      case 1:
        if (!form.piFullName.trim()) return "Full name is required.";
        if (!form.piEmail.trim()) return "Email address is required.";
        if (!form.piInstitution.trim()) return "Institution is required.";
        if (!form.projectTitle.trim()) return "Project title is required.";
        if (!form.projectStartDate) return "Project start date is required.";
        if (!form.projectEndDate) return "Project end date is required.";
        break;
      case 2:
        if (!form.projectGoals.trim()) return "Project goals and justification is required.";
        if (!form.methods.trim()) return "Detailed methods is required.";
        if (!form.samplesDetailsNA && !form.samplesDetails.trim())
          return "Sample collection details is required, or check \"Not applicable to my project\".";
        if (!form.geneticResourcesNA && !form.geneticResources.trim())
          return "Genetic resources details is required, or check \"Not applicable to my project\".";
        break;
      case 3: {
        if (!form.facilitiesNeeds.trim())
          return "Use of FCAT facilities and resources is required.";
        if (!form.permanentEquipmentNA && !form.permanentEquipment.trim())
          return "Permanent equipment details is required, or check \"Not applicable to my project\".";
        if (!form.personnelCollaboration.trim())
          return "FCAT personnel and collaboration is required.";
        if (!form.communityEngagement.trim())
          return "Community engagement and outreach is required.";
        if (!form.dataSharing.trim())
          return "Data sharing and dissemination is required.";
        if (!form.permitsStatusNA && !form.permitsStatus.trim())
          return "Research permits status is required, or check \"Not applicable\".";
        const ref1 = form.references[0];
        if (!ref1?.name.trim())
          return "Reference #1 full name is required.";
        if (!ref1?.email.trim())
          return "Reference #1 email is required.";
        break;
      }
    }
    return null;
  }

  function nextStep() {
    const err = validateStep(step);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    if (step < FORM_STEPS.length - 1) {
      setStep(step + 1);
      window.scrollTo(0, 0);
    }
  }

  function prevStep() {
    if (step > 0) {
      setStep(step - 1);
      window.scrollTo(0, 0);
    }
  }

  function handleSubmit() {
    setError(null);

    startTransition(async () => {
      const fd = new FormData();

      // Text fields
      const textFields: (keyof FormState)[] = [
        "piFullName", "piEmail", "piPhone", "piInstitution", "collaborators",
        "projectTitle", "projectStartDate", "projectEndDate",
        "projectGoals", "methods", "samplesDetails", "geneticResources",
        "facilitiesNeeds", "permanentEquipment", "personnelCollaboration",
        "communityEngagement", "dataSharing", "permitsStatus",
      ];

      // N/A overrides: when checkbox is checked, send "N/A" instead of empty string
      const naOverrides: Record<string, boolean> = {
        samplesDetails: form.samplesDetailsNA,
        geneticResources: form.geneticResourcesNA,
        permanentEquipment: form.permanentEquipmentNA,
        permitsStatus: form.permitsStatusNA,
      };

      for (const key of textFields) {
        const val = String(form[key] ?? "");
        fd.set(key, naOverrides[key] && !val.trim() ? "N/A" : val);
      }

      // Booleans
      if (form.needsFcatAssistance) fd.set("needsFcatAssistance", "on");
      if (form.codeOfConductAgreed) fd.set("codeOfConductAgreed", "on");
      if (form.guidelinesAgreed) fd.set("guidelinesAgreed", "on");

      // References as JSON
      const validRefs = form.references.filter((r) => r.name.trim());
      fd.set("references", JSON.stringify(validRefs));

      // Research permits files
      for (const file of permitFiles) {
        fd.append("researchPermits", file);
      }

      // Supporting documents files
      for (const file of supportingFiles) {
        fd.append("supportingDocuments", file);
      }

      // Turnstile token
      if (turnstileToken) {
        fd.set("turnstileToken", turnstileToken);
      }

      const result = await submitApplication(fd);

      if (result.success) {
        clearDraft();
        router.push(`/public/apply/thanks?ref=${result.data.referenceCode}`);
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <div className="space-y-6">
      {/* Progress indicator */}
      <div className="flex gap-2">
        {FORM_STEPS.map((label, i) => (
          <button
            key={label}
            onClick={() => setStep(i)}
            className={`flex-1 text-center py-2 text-sm rounded-md transition-colors ${
              i === step
                ? "bg-primary text-primary-foreground font-medium"
                : i < step
                  ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground"
            }`}
          >
            <span className="hidden sm:inline">{label}</span>
            <span className="sm:hidden">{i + 1}</span>
          </button>
        ))}
      </div>

      {/* Step content */}
      <Card>
        <CardHeader>
          <CardTitle>{FORM_STEPS[step]}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* ---------------------------------------------------------- */}
          {/* Step 0: Required Agreements                                 */}
          {/* ---------------------------------------------------------- */}
          {step === 0 && (
            <>
              <div className="space-y-4">
                <div className="rounded-lg border p-4 space-y-3">
                  <h3 className="font-medium">FCAT Code of Conduct</h3>
                  <p className="text-sm text-muted-foreground">
                    Please review and agree to abide by the FCAT Code of Conduct,
                    which outlines expectations for research ethics, integrity,
                    and responsibility.
                  </p>
                  <p className="text-sm">
                    <a
                      href="https://docs.google.com/document/d/1PeFwZLvk-MPVK4AUWHWwP8oCE1IFa46v/edit"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline underline-offset-4 hover:text-primary/80"
                    >
                      Link to the FCAT Code of Conduct
                    </a>
                  </p>
                  <div className="flex items-start gap-2 pt-2 border-t">
                    <Checkbox
                      id="codeOfConductAgreed"
                      checked={form.codeOfConductAgreed}
                      onCheckedChange={(v) =>
                        updateField("codeOfConductAgreed", v === true)
                      }
                    />
                    <Label htmlFor="codeOfConductAgreed" className="font-normal leading-snug">
                      By clicking this checkbox, you are certifying that you have
                      read and agree to the FCAT Code of Conduct. *
                    </Label>
                  </div>
                </div>

                <div className="rounded-lg border p-4 space-y-3">
                  <h3 className="font-medium">
                    FCAT Researcher Guidelines and Expectations
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    Please review and agree to abide by the FCAT Researcher
                    Guidelines and Expectations Document, which details the norms
                    and expectations of conducting research at the FCAT Reserve.
                  </p>
                  <p className="text-sm">
                    <a
                      href="https://drive.google.com/file/d/17LB35J_koqyDJaWXyZSsEQS9L8Xhy_nb/view?usp=sharing"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline underline-offset-4 hover:text-primary/80"
                    >
                      Link to the FCAT Researcher Guidelines and Expectations Document
                    </a>
                  </p>
                  <div className="flex items-start gap-2 pt-2 border-t">
                    <Checkbox
                      id="guidelinesAgreed"
                      checked={form.guidelinesAgreed}
                      onCheckedChange={(v) =>
                        updateField("guidelinesAgreed", v === true)
                      }
                    />
                    <Label htmlFor="guidelinesAgreed" className="font-normal leading-snug">
                      By clicking this checkbox, you are certifying that you have
                      read and agree to the FCAT Researcher Guidelines and
                      Expectations Document. *
                    </Label>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950 p-4 space-y-2">
                <h3 className="font-medium">Final Report Requirement</h3>
                <p className="text-sm text-muted-foreground">
                  If your application is approved, you will be required to submit
                  a final report within 3 months of your project&apos;s completion
                  date. A link to the report submission form will be included in
                  your approval email, and reminder emails will be sent as your
                  deadline approaches.
                </p>
              </div>
            </>
          )}

          {/* ---------------------------------------------------------- */}
          {/* Step 1: Applicant Information                               */}
          {/* ---------------------------------------------------------- */}
          {step === 1 && (
            <>
              <p className="text-sm text-muted-foreground">
                Please provide the name, title, institution, and contact
                information of the person conducting the field research project.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="piFullName">Full Name *</Label>
                  <Input
                    id="piFullName"
                    value={form.piFullName}
                    onChange={(e) => updateField("piFullName", e.target.value)}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="piEmail">Email Address *</Label>
                  <Input
                    id="piEmail"
                    type="email"
                    value={form.piEmail}
                    onChange={(e) => updateField("piEmail", e.target.value)}
                    required
                  />
                  <Hint>Please enter your email address.</Hint>
                </div>
                <div>
                  <Label htmlFor="piPhone">Cell-phone Number</Label>
                  <Input
                    id="piPhone"
                    value={form.piPhone}
                    onChange={(e) => updateField("piPhone", e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="piInstitution">Institution *</Label>
                  <Input
                    id="piInstitution"
                    value={form.piInstitution}
                    onChange={(e) => updateField("piInstitution", e.target.value)}
                    required
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="projectTitle">Project Title *</Label>
                <Input
                  id="projectTitle"
                  value={form.projectTitle}
                  onChange={(e) => updateField("projectTitle", e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="collaborators">Collaborators</Label>
                <Textarea
                  id="collaborators"
                  value={form.collaborators}
                  onChange={(e) => updateField("collaborators", e.target.value)}
                  placeholder="Names and affiliations of collaborators"
                  rows={3}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="projectStartDate">Project Start Date *</Label>
                  <Input
                    id="projectStartDate"
                    type="date"
                    value={form.projectStartDate}
                    onChange={(e) => updateField("projectStartDate", e.target.value)}
                    required
                  />
                  <Hint>Specify the start date of the research project.</Hint>
                </div>
                <div>
                  <Label htmlFor="projectEndDate">Project End Date *</Label>
                  <Input
                    id="projectEndDate"
                    type="date"
                    value={form.projectEndDate}
                    onChange={(e) => updateField("projectEndDate", e.target.value)}
                    required
                  />
                  <Hint>Specify the end date of the research project.</Hint>
                </div>
              </div>
            </>
          )}

          {/* ---------------------------------------------------------- */}
          {/* Step 2: Project Details                                     */}
          {/* ---------------------------------------------------------- */}
          {step === 2 && (
            <>
              <div>
                <Label htmlFor="projectGoals">Project Goals and Justification *</Label>
                <Hint>
                  Briefly describe the main goals and objectives of the research
                  project.
                </Hint>
                <Textarea
                  id="projectGoals"
                  value={form.projectGoals}
                  onChange={(e) => updateField("projectGoals", e.target.value)}
                  rows={6}
                  required
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="methods">Detailed Methods *</Label>
                <Hint>
                  Provide a detailed description of the research methods and
                  protocols that will be used, including sampling techniques and
                  data collection plans.
                </Hint>
                <Textarea
                  id="methods"
                  value={form.methods}
                  onChange={(e) => updateField("methods", e.target.value)}
                  rows={6}
                  required
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="samplesDetails">
                  Sample Collection, Storage, Movement, and Export Details *
                </Label>
                <Hint>
                  Describe any plans for collecting, storing, moving, or exporting
                  biological samples, including the types of samples, quantities,
                  and destinations.
                </Hint>
                <div className="flex items-center gap-2 mt-2">
                  <Checkbox
                    id="samplesDetailsNA"
                    checked={form.samplesDetailsNA}
                    onCheckedChange={(v) =>
                      updateField("samplesDetailsNA", v === true)
                    }
                  />
                  <Label htmlFor="samplesDetailsNA" className="font-normal text-sm">
                    Not applicable to my project
                  </Label>
                </div>
                {!form.samplesDetailsNA && (
                  <Textarea
                    id="samplesDetails"
                    value={form.samplesDetails}
                    onChange={(e) => updateField("samplesDetails", e.target.value)}
                    rows={4}
                    className="mt-1"
                  />
                )}
              </div>
              <div>
                <Label htmlFor="geneticResources">Genetic Resources Details *</Label>
                <Hint>
                  If the research involves access to or use of genetic resources,
                  provide details on the specific resources, their origins, and any
                  plans for benefit-sharing or compliance with relevant regulations
                  such as the Nagoya Protocol.
                </Hint>
                <div className="flex items-center gap-2 mt-2">
                  <Checkbox
                    id="geneticResourcesNA"
                    checked={form.geneticResourcesNA}
                    onCheckedChange={(v) =>
                      updateField("geneticResourcesNA", v === true)
                    }
                  />
                  <Label htmlFor="geneticResourcesNA" className="font-normal text-sm">
                    Not applicable to my project
                  </Label>
                </div>
                {!form.geneticResourcesNA && (
                  <Textarea
                    id="geneticResources"
                    value={form.geneticResources}
                    onChange={(e) => updateField("geneticResources", e.target.value)}
                    rows={4}
                    className="mt-1"
                  />
                )}
              </div>
            </>
          )}

          {/* ---------------------------------------------------------- */}
          {/* Step 3: Logistics & References                              */}
          {/* ---------------------------------------------------------- */}
          {step === 3 && (
            <>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="needsFcatAssistance"
                  checked={form.needsFcatAssistance}
                  onCheckedChange={(v) =>
                    updateField("needsFcatAssistance", v === true)
                  }
                />
                <Label htmlFor="needsFcatAssistance">
                  Do you require the assistance of FCAT for the proposed research?
                </Label>
              </div>
              <div>
                <Label htmlFor="facilitiesNeeds">
                  Use of FCAT Facilities and Resources *
                </Label>
                <Hint>
                  Specify any equipment, supplies, or storage facilities that will
                  be needed from FCAT to support the research project.
                </Hint>
                <Textarea
                  id="facilitiesNeeds"
                  value={form.facilitiesNeeds}
                  onChange={(e) => updateField("facilitiesNeeds", e.target.value)}
                  rows={3}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="permanentEquipment">
                  Installation of Permanent Equipment or Infrastructure *
                </Label>
                <Hint>
                  If the project involves the installation of any permanent
                  equipment or infrastructure at FCAT sites, provide details on the
                  specific items, locations, and plans for long-term maintenance and
                  use.
                </Hint>
                <div className="flex items-center gap-2 mt-2">
                  <Checkbox
                    id="permanentEquipmentNA"
                    checked={form.permanentEquipmentNA}
                    onCheckedChange={(v) =>
                      updateField("permanentEquipmentNA", v === true)
                    }
                  />
                  <Label htmlFor="permanentEquipmentNA" className="font-normal text-sm">
                    Not applicable to my project
                  </Label>
                </div>
                {!form.permanentEquipmentNA && (
                  <Textarea
                    id="permanentEquipment"
                    value={form.permanentEquipment}
                    onChange={(e) => updateField("permanentEquipment", e.target.value)}
                    rows={3}
                    className="mt-1"
                  />
                )}
              </div>
              <div>
                <Label htmlFor="personnelCollaboration">
                  FCAT Personnel and Collaboration *
                </Label>
                <Hint>
                  Describe any anticipated collaboration with FCAT staff or
                  researchers, including roles, responsibilities, and expected
                  outcomes.
                </Hint>
                <Textarea
                  id="personnelCollaboration"
                  value={form.personnelCollaboration}
                  onChange={(e) => updateField("personnelCollaboration", e.target.value)}
                  rows={3}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="communityEngagement">
                  Community Engagement and Outreach *
                </Label>
                <Hint>
                  FCAT values community engagement and outreach as an integral part
                  of the research process. Please describe any plans for involving
                  local communities or stakeholders in the research project, such as
                  through participatory methods, capacity building, or dissemination
                  of results.
                </Hint>
                <Textarea
                  id="communityEngagement"
                  value={form.communityEngagement}
                  onChange={(e) => updateField("communityEngagement", e.target.value)}
                  rows={3}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="dataSharing">Data Sharing and Dissemination *</Label>
                <Hint>
                  Describe any plans for sharing research data, results, or outputs
                  with FCAT, local communities, or other stakeholders, including
                  through publications, presentations, or other dissemination
                  channels.
                </Hint>
                <Textarea
                  id="dataSharing"
                  value={form.dataSharing}
                  onChange={(e) => updateField("dataSharing", e.target.value)}
                  rows={3}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="permitsStatus">
                  Research Permits Status *
                </Label>
                <Hint>
                  If permits are pending or will be applied for separately, please
                  indicate the status and expected timeline for approval. Note that
                  final approval of the research project by FCAT may be contingent
                  on obtaining all necessary permits.
                </Hint>
                <div className="flex items-center gap-2 mt-2">
                  <Checkbox
                    id="permitsStatusNA"
                    checked={form.permitsStatusNA}
                    onCheckedChange={(v) =>
                      updateField("permitsStatusNA", v === true)
                    }
                  />
                  <Label htmlFor="permitsStatusNA" className="font-normal text-sm">
                    I will upload permits in the next step
                  </Label>
                </div>
                {!form.permitsStatusNA && (
                  <Textarea
                    id="permitsStatus"
                    value={form.permitsStatus}
                    onChange={(e) => updateField("permitsStatus", e.target.value)}
                    rows={3}
                    className="mt-1"
                  />
                )}
              </div>

              {/* References */}
              <div className="space-y-4 pt-4 border-t">
                <h3 className="font-medium">References</h3>
                <p className="text-sm text-muted-foreground">
                  Provide the names and contact information for up to three
                  professional references who can speak to the qualifications and
                  experience of the research team. Please provide at least one
                  reference.
                </p>
                {form.references.map((ref, i) => (
                  <div key={i} className="grid gap-3 sm:grid-cols-3 p-3 rounded-lg bg-muted/50">
                    <div>
                      <Label htmlFor={`ref-name-${i}`}>
                        Reference #{i + 1} — Full Name {i === 0 && "*"}
                      </Label>
                      <Input
                        id={`ref-name-${i}`}
                        value={ref.name}
                        onChange={(e) => updateReference(i, "name", e.target.value)}
                        required={i === 0}
                      />
                    </div>
                    <div>
                      <Label htmlFor={`ref-email-${i}`}>
                        Email {i === 0 && "*"}
                      </Label>
                      <Input
                        id={`ref-email-${i}`}
                        type="email"
                        value={ref.email}
                        onChange={(e) => updateReference(i, "email", e.target.value)}
                        required={i === 0}
                      />
                    </div>
                    <div>
                      <Label htmlFor={`ref-phone-${i}`}>Phone</Label>
                      <Input
                        id={`ref-phone-${i}`}
                        value={ref.phone}
                        onChange={(e) => updateReference(i, "phone", e.target.value)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ---------------------------------------------------------- */}
          {/* Step 4: Documents & Submit                                  */}
          {/* ---------------------------------------------------------- */}
          {step === 4 && (
            <>
              <FileDropzone
                id="researchPermits"
                files={permitFiles}
                onChange={setPermitFiles}
                label="Research Permits (PDF, JPEG, PNG — max 10 MB each, 25 MB total)"
                hint="If research permits have already been obtained or are pending approval, please upload copies here."
              />

              <FileDropzone
                id="supportingDocuments"
                files={supportingFiles}
                onChange={setSupportingFiles}
                label="Supporting Documents (PDF, JPEG, PNG — max 10 MB each, 25 MB total)"
                hint="Please upload any relevant supporting documents, such as grant proposals or maps, that will help the FCAT Scientific Committee evaluate the feasibility and appropriateness of the proposed research project."
              />

              {/* Honeypot — hidden from real users */}
              <div className="sr-only" aria-hidden="true">
                <label htmlFor="website">Website</label>
                <input
                  type="text"
                  id="website"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                />
              </div>

              {/* Turnstile */}
              {process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY && (
                <Turnstile
                  siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY}
                  onSuccess={setTurnstileToken}
                />
              )}

              {/* Privacy notice */}
              <p className="text-xs text-muted-foreground">
                Your information will be retained by FCAT for the purposes of managing
                research at the reserve. Your IP address is logged for abuse prevention
                and automatically deleted after 90 days.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* Error */}
      {error && (
        <div className="rounded-md bg-destructive/10 text-destructive px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {/* Navigation */}
      <div className="flex justify-between">
        <Button
          variant="outline"
          onClick={prevStep}
          disabled={step === 0}
        >
          Previous
        </Button>

        {step < FORM_STEPS.length - 1 ? (
          <Button onClick={nextStep}>Next</Button>
        ) : (
          <Button
            onClick={handleSubmit}
            disabled={
              isPending ||
              !form.codeOfConductAgreed ||
              !form.guidelinesAgreed
            }
          >
            {isPending ? "Submitting..." : "Submit Application"}
          </Button>
        )}
      </div>
    </div>
  );
}
