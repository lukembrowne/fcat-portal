/**
 * App state keys — namespaced by module so multiple modules can store
 * "last X" timestamps without colliding.
 */

/** Last successful Drive sync for the camera trap module. */
export const CAMERA_TRAP_DRIVE_LAST_SYNC_KEY = "camera_trap_drive_last_sync_at";

/** Last successful Drive sync for the audio (Grabaciones) module. */
export const AUDIO_DRIVE_LAST_SYNC_KEY = "audio_drive_last_sync_at";
