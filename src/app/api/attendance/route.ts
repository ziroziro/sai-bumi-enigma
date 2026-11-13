import { NextResponse } from "next/server";
import {
  getServerAttendanceMetadata,
  recordServerAttendance,
  resetAllServerAttendance,
} from "@/server/attendance-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const meta = getServerAttendanceMetadata();
    return NextResponse.json({
      records: meta.records,
      lastResetAt: meta.lastResetAt,
      deletedNiks: meta.deletedNiks,
    });
  } catch {
    return NextResponse.json({ error: "Gagal memuat data kehadiran." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (body.resetAll) {
      const records = await resetAllServerAttendance();
      return NextResponse.json({ success: true, records });
    }
    const { nik, timestamp } = body;
    if (!nik || typeof nik !== "string") {
      return NextResponse.json({ error: "NIK diperlukan." }, { status: 400 });
    }

    const records = recordServerAttendance(nik.trim().toUpperCase(), timestamp);
    return NextResponse.json({ success: true, records });
  } catch {
    return NextResponse.json({ error: "Gagal mencatat kehadiran." }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const records = await resetAllServerAttendance();
    return NextResponse.json({ success: true, message: "Semua data absensi telah dikosongkan.", records });
  } catch {
    return NextResponse.json({ error: "Gagal mengosongkan data absensi." }, { status: 500 });
  }
}
