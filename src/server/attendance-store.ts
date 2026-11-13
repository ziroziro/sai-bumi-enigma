import "server-only";
import fs from "node:fs";
import path from "node:path";

export interface AttendanceState {
  records: Record<string, string>;
  lastResetAt: string | null;
  deletedNiks: string[];
}

const DATA_FILE_PATH = path.join(process.cwd(), ".attendance-data.json");

function readStateFromDisk(): AttendanceState {
  try {
    if (fs.existsSync(DATA_FILE_PATH)) {
      const content = fs.readFileSync(DATA_FILE_PATH, "utf8");
      const parsed = JSON.parse(content);
      return {
        records: typeof parsed.records === "object" && parsed.records !== null ? parsed.records : {},
        lastResetAt: typeof parsed.lastResetAt === "string" ? parsed.lastResetAt : null,
        deletedNiks: Array.isArray(parsed.deletedNiks) ? parsed.deletedNiks : [],
      };
    }
  } catch {
    // fallback
  }
  return {
    records: {},
    lastResetAt: null,
    deletedNiks: [],
  };
}

function writeStateToDisk(state: AttendanceState): void {
  try {
    fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Ignore in read-only environments
  }
}

// Global in-memory storage to synchronize attendance across requests and persist across Fast Refresh
const globalAttendanceStore = globalThis as unknown as {
  __sai_bumi_attendance_state?: AttendanceState;
};

if (!globalAttendanceStore.__sai_bumi_attendance_state) {
  globalAttendanceStore.__sai_bumi_attendance_state = readStateFromDisk();
}

function getActiveState(): AttendanceState {
  if (!globalAttendanceStore.__sai_bumi_attendance_state) {
    globalAttendanceStore.__sai_bumi_attendance_state = readStateFromDisk();
  }
  return globalAttendanceStore.__sai_bumi_attendance_state;
}

export function getServerAttendanceRecords(): Record<string, string> {
  const state = getActiveState();
  return { ...state.records };
}

export function getServerAttendanceMetadata(): {
  records: Record<string, string>;
  lastResetAt: string | null;
  deletedNiks: string[];
} {
  const state = getActiveState();
  return {
    records: { ...state.records },
    lastResetAt: state.lastResetAt,
    deletedNiks: [...state.deletedNiks],
  };
}

export function recordServerAttendance(nik: string, timestamp?: string): Record<string, string> {
  const state = getActiveState();
  const isoStr = timestamp || new Date().toISOString();
  state.records[nik] = state.records[nik] || isoStr;
  state.deletedNiks = state.deletedNiks.filter((n) => n !== nik);
  globalAttendanceStore.__sai_bumi_attendance_state = state;
  writeStateToDisk(state);
  return { ...state.records };
}

export function deleteServerAttendance(nik: string): Record<string, string> {
  const state = getActiveState();
  delete state.records[nik];
  if (!state.deletedNiks.includes(nik)) {
    state.deletedNiks.push(nik);
  }
  globalAttendanceStore.__sai_bumi_attendance_state = state;
  writeStateToDisk(state);
  return { ...state.records };
}

export async function resetAllServerAttendance(): Promise<Record<string, string>> {
  const state: AttendanceState = {
    records: {},
    lastResetAt: new Date().toISOString(),
    deletedNiks: [],
  };
  globalAttendanceStore.__sai_bumi_attendance_state = state;
  writeStateToDisk(state);

  if (process.env.APP_DATA_MODE !== "demo") {
    try {
      const { createBackendClient } = await import("./supabase");
      const { client } = createBackendClient();
      await client
        .from("attendance_records")
        .delete()
        .neq("id", "00000000-0000-0000-0000-000000000000");
    } catch {
      // Graceful fallback if database schema is local
    }
  }

  return {};
}
