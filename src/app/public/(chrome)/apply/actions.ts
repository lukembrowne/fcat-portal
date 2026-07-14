"use server";

import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  researchApplications,
  researchApplicationReferences,
} from "@/db/schema";
import { verifyTurnstile } from "@/lib/turnstile";
import { validateUploads } from "@/lib/upload-validation";
import {
  getOrCreateApplicationFolder,
  uploadFileToSharedDrive,
  deleteDriveFile,
  renameDriveFile,
  type UploadedFileInfo,
} from "@/lib/drive-client";
import { applicationSchema, type ApplicationFormData } from "./fields";
import type { ActionResult } from "@/lib/types";
import { log } from "@/lib/log";

/**
 * Submit a researcher application from the public form.
 *
 * No auth required — this is a public endpoint. Turnstile + honeypot protect
 * against spam. Error messages are generic to avoid information leakage.
 */
export async function submitApplication(
  formData: FormData
): Promise<ActionResult<{ referenceCode: string }>> {
  try {
    const headerList = await headers();
    const ip =
      headerList.get("x-real-ip") ??
      headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      null;

    // 1. Verify Turnstile
    const turnstileToken = formData.get("turnstileToken") as string | null;
    const turnstileResult = await verifyTurnstile(turnstileToken, ip);
    if (!turnstileResult.success) {
      return { success: false, error: "Verification failed. Please try again." };
    }

    // 2. Check honeypot
    const honeypot = formData.get("website");
    if (honeypot) {
      // Silent reject — looks like success to bots
      return {
        success: true,
        data: { referenceCode: "FCAT-0000-00000" },
      };
    }

    // 3. Parse and validate fields
    const rawData: Record<string, unknown> = {};
    const fieldKeys = [
      "piFullName",
      "piEmail",
      "piPhone",
      "piInstitution",
      "collaborators",
      "projectTitle",
      "projectStartDate",
      "projectEndDate",
      "projectGoals",
      "methods",
      "samplesDetails",
      "geneticResources",
      "needsFcatAssistance",
      "facilitiesNeeds",
      "permanentEquipment",
      "personnelCollaboration",
      "communityEngagement",
      "dataSharing",
      "permitsStatus",
    ];

    for (const key of fieldKeys) {
      const val = formData.get(key);
      if (key === "needsFcatAssistance") {
        rawData[key] = val === "on" || val === "true";
      } else {
        rawData[key] = typeof val === "string" ? val : "";
      }
    }

    // Agreements (checkboxes)
    rawData.codeOfConductAgreed =
      formData.get("codeOfConductAgreed") === "on" ||
      formData.get("codeOfConductAgreed") === "true";
    rawData.guidelinesAgreed =
      formData.get("guidelinesAgreed") === "on" ||
      formData.get("guidelinesAgreed") === "true";

    // References (JSON-encoded array from client)
    const refsRaw = formData.get("references");
    if (typeof refsRaw === "string") {
      try {
        rawData.references = JSON.parse(refsRaw);
      } catch {
        rawData.references = [];
      }
    } else {
      rawData.references = [];
    }

    const parsed = applicationSchema.safeParse(rawData);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      return {
        success: false,
        error: firstError?.message ?? "Invalid form data",
      };
    }

    const data: ApplicationFormData = parsed.data;

    // 4. Collect files from both upload fields
    const permitEntries: File[] = [];
    for (const entry of formData.getAll("researchPermits")) {
      if (entry instanceof File && entry.size > 0) {
        permitEntries.push(entry);
      }
    }

    const supportEntries: File[] = [];
    for (const entry of formData.getAll("supportingDocuments")) {
      if (entry instanceof File && entry.size > 0) {
        supportEntries.push(entry);
      }
    }

    const allFileEntries = [...permitEntries, ...supportEntries];

    const uploadedFiles: UploadedFileInfo[] = [];
    const uploadedFileIds: string[] = [];
    let driveFolderId: string | null = null;

    if (allFileEntries.length > 0) {
      // Validate all files together (shared 25 MB total limit)
      const validation = await validateUploads(allFileEntries, "files");
      if ("errors" in validation) {
        return {
          success: false,
          error: validation.errors[0]?.message ?? "File validation failed",
        };
      }

      // 5. Upload files to Drive (before DB transaction)
      // Use a temporary name — will be renamed to reference code after DB insert
      const tempFolderName = `pending-${Date.now()}`;
      try {
        driveFolderId = await getOrCreateApplicationFolder(tempFolderName);
      } catch (err) {
        log.error({ err }, "[ResearchApp] Failed to create Drive folder");
        return {
          success: false,
          error: "Unable to process your application. Please try again or email Luis Carrasco, FCAT Reserve Director, at luiscarrasco@fcat-ecuador.org.",
        };
      }

      // Track which validated files are permits vs supporting
      const permitCount = permitEntries.length;

      for (let i = 0; i < validation.files.length; i++) {
        const file = validation.files[i];
        const category = i < permitCount ? "permit" : "supporting";
        try {
          const driveFile = await uploadFileToSharedDrive(
            file.buffer,
            file.sanitizedName,
            file.mimeType,
            driveFolderId!
          );
          uploadedFiles.push({ ...driveFile, category });
          uploadedFileIds.push(driveFile.id);
        } catch (err) {
          log.error(
            { err, filename: file.sanitizedName },
            "[ResearchApp] Drive upload failed, cleaning up"
          );
          // Clean up already-uploaded files
          for (const id of uploadedFileIds) {
            try {
              await deleteDriveFile(id);
            } catch {
              // Best-effort cleanup
            }
          }
          return {
            success: false,
            error: "Unable to process your application. Please try again or email Luis Carrasco, FCAT Reserve Director, at luiscarrasco@fcat-ecuador.org.",
          };
        }
      }
    }

    // 6. Insert into DB (sync transaction)
    const now = Math.floor(Date.now() / 1000);
    const result = db.transaction(() => {
      const inserted = db
        .insert(researchApplications)
        .values({
          status: "submitted",
          projectTitle: data.projectTitle,
          piFullName: data.piFullName,
          piEmail: data.piEmail,
          piPhone: data.piPhone ?? null,
          piInstitution: data.piInstitution ?? null,
          collaborators: data.collaborators ?? null,
          projectStartDate: data.projectStartDate ?? null,
          projectEndDate: data.projectEndDate ?? null,
          projectGoals: data.projectGoals ?? null,
          methods: data.methods ?? null,
          samplesDetails: data.samplesDetails ?? null,
          geneticResources: data.geneticResources ?? null,
          needsFcatAssistance: data.needsFcatAssistance,
          facilitiesNeeds: data.facilitiesNeeds ?? null,
          permanentEquipment: data.permanentEquipment ?? null,
          personnelCollaboration: data.personnelCollaboration ?? null,
          communityEngagement: data.communityEngagement ?? null,
          dataSharing: data.dataSharing ?? null,
          codeOfConductAgreed: data.codeOfConductAgreed,
          guidelinesAgreed: data.guidelinesAgreed,
          permitsStatus: data.permitsStatus ?? null,
          driveFolderId,
          driveFilesJson:
            uploadedFiles.length > 0 ? JSON.stringify(uploadedFiles) : null,
          submitterIp: ip,
          createdAt: new Date(now * 1000),
          updatedAt: new Date(now * 1000),
        })
        .run();

      const id = Number(inserted.lastInsertRowid);
      const year = new Date().getFullYear();
      const code = `FCAT-${year}-${String(id).padStart(5, "0")}`;

      db.update(researchApplications)
        .set({ referenceCode: code })
        .where(eq(researchApplications.id, id))
        .run();

      // Insert references
      for (let i = 0; i < data.references.length; i++) {
        const ref = data.references[i];
        db.insert(researchApplicationReferences)
          .values({
            applicationId: id,
            ordinal: i + 1,
            name: ref.name,
            email: ref.email || null,
            phone: ref.phone ?? null,
          })
          .run();
      }

      return { id, code };
    });

    const applicationId = result.id;
    const referenceCode = result.code;

    // 7. Rename the Drive folder from pending-xxx to the reference code
    if (driveFolderId) {
      try {
        await renameDriveFile(driveFolderId, referenceCode);
      } catch (err) {
        log.error({ err, driveFolderId, referenceCode }, "[ResearchApp] Failed to rename Drive folder (non-blocking)");
      }
    }

    // 8. Send emails (inline, best-effort)
    try {
      const { sendSubmissionReceipt, sendCommitteeNewAppNotification } =
        await import("@/lib/research-applications/emails");
      await sendSubmissionReceipt(data.piEmail, referenceCode, data.projectTitle);
      await sendCommitteeNewAppNotification(
        referenceCode,
        data.projectTitle,
        data.piFullName,
        data.piInstitution
      );
    } catch (err) {
      log.error({ err, applicationId }, "[ResearchApp] Email send failed (non-blocking)");
    }

    log.info(
      { applicationId, referenceCode },
      "[ResearchApp] Application submitted"
    );

    return { success: true, data: { referenceCode } };
  } catch (err) {
    log.error({ err }, "[ResearchApp] Unexpected error during submission");
    return {
      success: false,
      error: "Unable to process your application. Please try again or email Luis Carrasco, FCAT Reserve Director, at luiscarrasco@fcat-ecuador.org.",
    };
  }
}
