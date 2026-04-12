import { z } from "zod";

/**
 * Zod schema for the researcher application form.
 *
 * Applicant-facing form is in English. Server-side errors returned in English
 * since the applicants are international researchers.
 */

export const referenceSchema = z.object({
  name: z.string().min(1, "Reference name is required"),
  email: z.string().email("Invalid email").or(z.literal("")),
  phone: z.string().optional(),
});

export const applicationSchema = z.object({
  // Step 1: Applicant info
  piFullName: z.string().min(1, "Full name is required"),
  piEmail: z.string().email("Invalid email address"),
  piPhone: z.string().optional(),
  piInstitution: z.string().min(1, "Institution is required"),
  collaborators: z.string().optional(),
  projectTitle: z.string().min(1, "Project title is required"),
  projectStartDate: z.string().min(1, "Start date is required"),
  projectEndDate: z.string().min(1, "End date is required"),

  // Step 2: Project details
  projectGoals: z.string().min(1, "Project goals are required"),
  methods: z.string().min(1, "Methods description is required"),
  samplesDetails: z.string().min(1, "Sample collection details are required (enter N/A if not applicable)"),
  geneticResources: z.string().min(1, "Genetic resources details are required (enter N/A if not applicable)"),

  // Step 3: Logistics
  needsFcatAssistance: z.boolean(),
  facilitiesNeeds: z.string().min(1, "Use of FCAT facilities is required"),
  permanentEquipment: z.string().min(1, "Permanent equipment details are required (enter N/A if not applicable)"),
  personnelCollaboration: z.string().min(1, "FCAT personnel and collaboration details are required"),
  communityEngagement: z.string().min(1, "Community engagement details are required"),
  dataSharing: z.string().min(1, "Data sharing details are required"),
  permitsStatus: z.string().min(1, "Research permits status is required (enter N/A if not applicable)"),

  // Step 3: References
  references: z
    .array(referenceSchema)
    .min(1, "At least one reference is required")
    .max(3)
    .refine(
      (refs) => refs.length === 0 || (refs[0].email && refs[0].email.length > 0),
      { message: "Email is required for Reference #1" }
    ),

  // Step 4: Agreements
  codeOfConductAgreed: z.literal(true, {
    error: "You must agree to the FCAT Code of Conduct",
  }),
  guidelinesAgreed: z.literal(true, {
    error: "You must agree to the Researcher Guidelines",
  }),
});

export type ApplicationFormData = z.infer<typeof applicationSchema>;

/** Step labels for the multi-step form */
export const FORM_STEPS = [
  "Required Agreements",
  "Applicant Information",
  "Project Details",
  "Logistics & References",
  "Documents & Submit",
] as const;
